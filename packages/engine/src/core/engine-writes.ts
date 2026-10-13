/**
 * The ledger of what the engine wrote in the repo (AD-7 rules 2 and 7). Agents work in the user's
 * checkout (phase roles, a BA or Designer answering a gap), where the engine also writes: the
 * event log, plan files, packs, results, scope records, evidence. A path the engine writes is not
 * exempt from the write check because of where it is; it is the engine's only while it holds
 * exactly the bytes the engine last wrote there. Every engine write (`writeRepoFile`,
 * `appendRepoFile`) is recorded here with the content hash it left; appends keep a running hash,
 * so the event log is never re-read to stay verified.
 *
 * The ledger is kept in `.vtc/state/engine-writes.jsonl` (one line per write, compacted on open)
 * so a restart can verify the files, the event log above all, before replaying them. Residual:
 * a change made while no engine runs, to a file and to the ledger alike, is not detectable.
 */
import { createHash, randomBytes, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  assertNoSymlinks,
  ensureRepoDir,
  observeRepoWrites,
  type RepoWrite,
} from "../git/index.js";

export const LEDGER_PATH = ".vtc/state/engine-writes.jsonl";

/** The digest of a file the engine removed. */
const REMOVED = "removed";

interface Entry {
  size: number;
  digest: string;
  /** Running hash of the whole file, kept for appended files once verified in this process. */
  hash?: Hash;
  /** Why the file is not what the engine wrote, once an append found it changed. */
  foreign?: string;
}

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const readOrNull = (abs: string): Buffer | null => {
  try {
    const stat = lstatSync(abs);
    return stat.isFile() ? readFileSync(abs) : null;
  } catch {
    return null;
  }
};

/** How a file compares with the engine's last write of it. */
export type WriteCheck =
  | {
      readonly ok: true;
      /** Intact only thanks to `tolerateTail`: one final line has no ledger entry yet. */
      readonly tolerated?: true;
    }
  | {
      readonly ok: false;
      readonly detail: string;
      /**
       * Bytes at the start of the file that are exactly what the engine wrote, when the change
       * only added bytes after them (an append by someone else).
       */
      readonly intactPrefix?: number;
    };

export class EngineWrites {
  private readonly entries = new Map<string, Entry>();
  private ledgerFd: number | null = null;
  private readonly ledgerHash = createHash("sha256");
  private ledgerSize = 0;
  private readonly stop: () => void;

  private constructor(private readonly repoRoot: string) {
    this.load();
    this.stop = observeRepoWrites(repoRoot, (write) => {
      this.observe(write);
    });
  }

  private static readonly current = new Map<string, EngineWrites>();

  /**
   * Loads (and compacts) the repo's ledger and records every later engine write. One ledger per
   * repo and process: opening it again (an engine re-opened on the repo) closes the previous one.
   */
  static open(repoRoot: string): EngineWrites {
    EngineWrites.current.get(repoRoot)?.close();
    const ledger = new EngineWrites(repoRoot);
    EngineWrites.current.set(repoRoot, ledger);
    return ledger;
  }

  close(): void {
    this.stop();
    if (this.ledgerFd !== null) closeSync(this.ledgerFd);
    this.ledgerFd = null;
  }

  private abs(rel: string): string {
    return join(this.repoRoot, rel);
  }

  private load(): void {
    const abs = this.abs(LEDGER_PATH);
    const text = existsSync(abs) ? (readOrNull(abs)?.toString("utf8") ?? "") : "";
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      try {
        const v = JSON.parse(line) as { p?: unknown; s?: unknown; d?: unknown };
        if (typeof v.p === "string" && typeof v.s === "number" && typeof v.d === "string")
          this.entries.set(v.p, { size: v.s, digest: v.d });
      } catch {
        // a torn line (a crash mid-append): the entry before it stands
      }
    }
    // Compact: one line per path, written whole, then appended to.
    ensureRepoDir(this.repoRoot, ".vtc/state");
    assertNoSymlinks(this.repoRoot, LEDGER_PATH);
    const compact = [...this.entries]
      .map(([p, e]) => `${JSON.stringify({ p, s: e.size, d: e.digest })}\n`)
      .join("");
    // A fresh temp file (never an existing path an agent could have planted), renamed into place.
    const temp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      writeSync(fd, compact);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, abs);
    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    this.ledgerFd = openSync(abs, constants.O_WRONLY | constants.O_APPEND | noFollow);
    this.ledgerHash.update(compact);
    this.ledgerSize = Buffer.byteLength(compact);
  }

  private persist(rel: string, entry: Entry): void {
    if (this.ledgerFd === null) return;
    const line = `${JSON.stringify({ p: rel, s: entry.size, d: entry.digest })}\n`;
    writeSync(this.ledgerFd, line);
    this.ledgerHash.update(line);
    this.ledgerSize += Buffer.byteLength(line);
  }

  private observe(write: RepoWrite): void {
    if (write.kind === "remove") {
      const entry: Entry = { size: 0, digest: REMOVED };
      this.entries.set(write.rel, entry);
      this.persist(write.rel, entry);
      return;
    }
    if (write.kind === "write") {
      const hash = createHash("sha256").update(write.content);
      const entry: Entry = {
        size: write.content.byteLength,
        digest: hash.copy().digest("hex"),
        hash,
      };
      this.entries.set(write.rel, entry);
      this.persist(write.rel, entry);
      return;
    }
    const previous = this.entries.get(write.rel);
    let entry: Entry;
    if (previous?.hash !== undefined && previous.size === write.sizeBefore) {
      previous.hash.update(write.content);
      previous.size += write.content.byteLength;
      previous.digest = previous.hash.copy().digest("hex");
      entry = previous;
    } else {
      // First append in this process, or the file changed since the last one: hash it whole.
      const bytes = readOrNull(this.abs(write.rel)) ?? Buffer.alloc(0);
      const before = bytes.subarray(0, write.sizeBefore);
      const hash = createHash("sha256").update(bytes);
      const fresh = previous === undefined && write.sizeBefore === 0;
      const known =
        previous !== undefined &&
        previous.size === write.sizeBefore &&
        previous.digest === sha(before);
      entry = {
        size: bytes.byteLength,
        digest: hash.copy().digest("hex"),
        hash,
        ...(previous?.foreign === undefined ? {} : { foreign: previous.foreign }),
      };
      if (!fresh && !known && previous !== undefined && entry.foreign === undefined) {
        entry.foreign = `it held ${String(write.sizeBefore)} bytes before an engine append; the engine had written ${String(previous.size)}`;
      }
    }
    this.entries.set(write.rel, entry);
    this.persist(write.rel, entry);
  }

  /** True when the engine has written `rel` (this process or, per the ledger, an earlier one). */
  has(rel: string): boolean {
    return rel === LEDGER_PATH || this.entries.has(rel);
  }

  /**
   * Is `rel` exactly what the engine last wrote? With `tolerateTail`, an extra final line after
   * the engine's bytes (an append whose ledger line a crash cut off) still counts as intact.
   */
  check(rel: string, options: { readonly tolerateTail?: boolean } = {}): WriteCheck {
    if (rel === LEDGER_PATH) return this.checkLedger();
    const entry = this.entries.get(rel);
    if (entry === undefined) return { ok: false, detail: "the engine never wrote it" };
    const bytes = readOrNull(this.abs(rel));
    if (entry.digest === REMOVED)
      return bytes === null && !existsSync(this.abs(rel))
        ? { ok: true }
        : { ok: false, detail: "the engine removed it and it came back" };
    if (bytes === null) return { ok: false, detail: "it was removed" };
    if (entry.foreign !== undefined) return { ok: false, detail: entry.foreign };
    if (bytes.byteLength === entry.size && sha(bytes) === entry.digest) return { ok: true };
    if (bytes.byteLength > entry.size && sha(bytes.subarray(0, entry.size)) === entry.digest) {
      const tail = bytes.subarray(entry.size).toString("utf8");
      const lines = tail.split("\n").filter((l) => l !== "").length;
      if (options.tolerateTail === true && lines <= 1) return { ok: true, tolerated: true };
      return {
        ok: false,
        detail: `${String(bytes.byteLength - entry.size)} bytes were added after the ${String(entry.size)} the engine wrote`,
        intactPrefix: entry.size,
      };
    }
    return { ok: false, detail: "its content is not what the engine wrote" };
  }

  private checkLedger(): WriteCheck {
    const bytes = readOrNull(this.abs(LEDGER_PATH));
    if (bytes === null) return { ok: false, detail: "it was removed" };
    return bytes.byteLength === this.ledgerSize &&
      sha(bytes) === this.ledgerHash.copy().digest("hex")
      ? { ok: true }
      : { ok: false, detail: "its content is not what the engine wrote" };
  }

  /** Takes `rel` as it is now as the engine's (a human vouched for it, e.g. by resuming). */
  accept(rel: string): void {
    if (rel === LEDGER_PATH) return;
    const bytes = readOrNull(this.abs(rel));
    if (bytes === null) {
      const removed: Entry = { size: 0, digest: REMOVED };
      this.entries.set(rel, removed);
      this.persist(rel, removed);
      return;
    }
    const hash = createHash("sha256").update(bytes);
    const entry: Entry = { size: bytes.byteLength, digest: hash.copy().digest("hex"), hash };
    this.entries.set(rel, entry);
    this.persist(rel, entry);
  }

  /** Why an engine append found `rel` changed by someone else, if one did (cheap: no read). */
  foreign(rel: string): string | undefined {
    return this.entries.get(rel)?.foreign;
  }

  /** Every recorded path that is no longer what the engine wrote. */
  changed(): string[] {
    return [...this.entries.keys()].filter((rel) => !this.check(rel).ok).sort();
  }

  /**
   * Records the current content of every file under `relDir` as the engine's: output the
   * engine's own Gate Runner wrote through its own file calls (reports, inventories).
   */
  adopt(relDir: string): void {
    const walk = (rel: string, depth: number): void => {
      let names: string[];
      try {
        names = readdirSync(this.abs(rel));
      } catch {
        return;
      }
      for (const name of names) {
        const child = `${rel}/${name}`;
        let stat;
        try {
          stat = lstatSync(this.abs(child));
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          if (depth > 0) walk(child, depth - 1);
        } else if (stat.isFile() && !this.check(child).ok) {
          this.accept(child);
        }
      }
    };
    walk(relDir, 4);
  }
}
