/**
 * The ledger of what the engine wrote in the repo (AD-7 rules 2 and 7). Roles can write anywhere
 * the host lets them, the repo included, so a path the engine writes (the event log, plan files,
 * packs, results, evidence) is the engine's only while it holds exactly the bytes the engine last
 * wrote there. Every engine write (`writeRepoFile`, `appendRepoFile`, `removeRepoFile`) is
 * recorded here with the content hash it left. Appends keep a running hash and a checkpoint per
 * append (size, digest), so the event log is never re-read to stay verified, and after a change
 * the longest prefix the engine wrote can be found ({@link EngineWrites.verifiedPrefix}).
 *
 * The ledger file lives in the engine's private directory (`guard.ts`: `<vtcHome>/guard/<key>/`,
 * 0600), outside every path a role can write, so a restart can verify the repo's files before
 * replaying them. Lines: `{p, s, d, k}` (path, size, digest, kind `w` write, `a` append, `r`
 * removal); compacted on open to each path's current append chain.
 */
import { createHash, type Hash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { observeRepoWrites, type RepoWrite } from "../git/index.js";
import { readPrivateFile, writePrivateFile } from "./guard.js";

/** The digest of a file the engine removed. */
const REMOVED = "removed";

type Kind = "w" | "a" | "r";

interface Entry {
  size: number;
  digest: string;
  /** Running hash of the whole file, kept for appended files once verified in this process. */
  hash?: Hash;
  /** Why the file is not what the engine wrote, once an append found it changed. */
  foreign?: string;
  /** `[size, digest]` after the last whole write and each append since (ascending sizes). */
  checkpoints: [number, string][];
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
export type WriteCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

export const NEVER_WROTE = "the engine never wrote it";

export class EngineWrites {
  private readonly entries = new Map<string, Entry>();
  private ledgerFd: number | null = null;
  private readonly stop: () => void;

  private constructor(
    private readonly repoRoot: string,
    private readonly ledgerPath: string,
  ) {
    this.load();
    this.stop = observeRepoWrites(repoRoot, (write) => {
      this.observe(write);
    });
  }

  private static readonly current = new Map<string, EngineWrites>();

  /**
   * Loads (and compacts) the repo's ledger at `ledgerPath` (in the engine's private directory)
   * and records every later engine write. One ledger per repo and process: opening it again (an
   * engine re-opened on the repo) closes the previous one.
   */
  static open(repoRoot: string, ledgerPath: string): EngineWrites {
    EngineWrites.current.get(repoRoot)?.close();
    const ledger = new EngineWrites(repoRoot, ledgerPath);
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
    const text = readPrivateFile(this.ledgerPath) ?? "";
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      let v: { p?: unknown; s?: unknown; d?: unknown; k?: unknown };
      try {
        v = JSON.parse(line) as typeof v;
      } catch {
        continue; // a torn line (a crash mid-append): the entry before it stands
      }
      if (typeof v.p !== "string" || typeof v.s !== "number" || typeof v.d !== "string") continue;
      const previous = this.entries.get(v.p);
      const checkpoints: [number, string][] =
        v.k === "a" && previous !== undefined && v.s >= previous.size
          ? [...previous.checkpoints, [v.s, v.d]]
          : [[v.s, v.d]];
      this.entries.set(v.p, { size: v.s, digest: v.d, checkpoints });
    }
    // Compact: each path's current chain, written whole, then appended to.
    const compact = [...this.entries]
      .flatMap(([p, e]) =>
        e.checkpoints.map(
          ([s, d], i) =>
            `${JSON.stringify({ p, s, d, k: i === 0 ? (d === REMOVED ? "r" : "w") : "a" })}\n`,
        ),
      )
      .join("");
    writePrivateFile(this.ledgerPath, compact);
    const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
    this.ledgerFd = openSync(this.ledgerPath, constants.O_WRONLY | constants.O_APPEND | noFollow);
  }

  private persist(rel: string, entry: Entry, k: Kind): void {
    if (this.ledgerFd === null) return;
    writeSync(this.ledgerFd, `${JSON.stringify({ p: rel, s: entry.size, d: entry.digest, k })}\n`);
  }

  private observe(write: RepoWrite): void {
    if (write.kind === "remove") {
      const entry: Entry = { size: 0, digest: REMOVED, checkpoints: [[0, REMOVED]] };
      this.entries.set(write.rel, entry);
      this.persist(write.rel, entry, "r");
      return;
    }
    if (write.kind === "write") {
      const hash = createHash("sha256").update(write.content);
      const digest = hash.copy().digest("hex");
      const size = write.content.byteLength;
      const entry: Entry = { size, digest, hash, checkpoints: [[size, digest]] };
      this.entries.set(write.rel, entry);
      this.persist(write.rel, entry, "w");
      return;
    }
    const previous = this.entries.get(write.rel);
    if (previous?.hash !== undefined && previous.size === write.sizeBefore) {
      previous.hash.update(write.content);
      previous.size += write.content.byteLength;
      previous.digest = previous.hash.copy().digest("hex");
      if (previous.foreign === undefined) {
        previous.checkpoints.push([previous.size, previous.digest]);
        this.persist(write.rel, previous, "a");
      }
      return;
    }
    // First append in this process, or the file changed since the last one: hash it whole.
    const bytes = readOrNull(this.abs(write.rel)) ?? Buffer.alloc(0);
    const before = bytes.subarray(0, write.sizeBefore);
    const hash = createHash("sha256").update(bytes);
    const fresh = write.sizeBefore === 0 && (previous === undefined || previous.digest === REMOVED);
    const known =
      previous !== undefined &&
      previous.foreign === undefined &&
      previous.size === write.sizeBefore &&
      previous.digest === sha(before);
    const entry: Entry = {
      size: bytes.byteLength,
      digest: hash.copy().digest("hex"),
      hash,
      checkpoints: known ? [...previous.checkpoints] : [],
      ...(previous?.foreign === undefined ? {} : { foreign: previous.foreign }),
    };
    if (fresh || known) {
      entry.checkpoints.push([entry.size, entry.digest]);
      this.entries.set(write.rel, entry);
      this.persist(write.rel, entry, fresh ? "w" : "a");
      return;
    }
    // Someone else changed the file: nothing after the engine's last checkpoint is vouched for
    // (the ledger keeps the old chain, so a restart replays only the verified prefix).
    entry.checkpoints = previous === undefined ? [] : [...previous.checkpoints];
    entry.foreign ??=
      previous === undefined
        ? `it held ${String(write.sizeBefore)} bytes the engine never wrote before an engine append`
        : `it held ${String(write.sizeBefore)} bytes before an engine append; the engine had written ${String(previous.size)}`;
    this.entries.set(write.rel, entry);
  }

  /** True when the engine has written `rel` (this process or, per the ledger, an earlier one). */
  has(rel: string): boolean {
    return this.entries.has(rel);
  }

  /** Is `rel` exactly what the engine last wrote? */
  check(rel: string): WriteCheck {
    const entry = this.entries.get(rel);
    if (entry === undefined) return { ok: false, detail: NEVER_WROTE };
    const bytes = readOrNull(this.abs(rel));
    if (entry.digest === REMOVED)
      return bytes === null && !existsSync(this.abs(rel))
        ? { ok: true }
        : { ok: false, detail: "the engine removed it and it came back" };
    if (bytes === null) return { ok: false, detail: "it was removed" };
    if (entry.foreign !== undefined) return { ok: false, detail: entry.foreign };
    if (bytes.byteLength === entry.size && sha(bytes) === entry.digest) return { ok: true };
    if (bytes.byteLength > entry.size && sha(bytes.subarray(0, entry.size)) === entry.digest)
      return {
        ok: false,
        detail: `${String(bytes.byteLength - entry.size)} bytes were added after the ${String(entry.size)} the engine wrote`,
      };
    if (bytes.byteLength < entry.size)
      return {
        ok: false,
        detail: `it holds ${String(bytes.byteLength)} of the ${String(entry.size)} bytes the engine wrote`,
      };
    return { ok: false, detail: "its content is not what the engine wrote" };
  }

  /**
   * The length of the longest prefix of `rel` that is exactly what the engine wrote up to one of
   * its writes or appends (0 when none is). Nothing after it may be replayed.
   */
  verifiedPrefix(rel: string): number {
    const entry = this.entries.get(rel);
    const bytes = readOrNull(this.abs(rel));
    if (entry === undefined || bytes === null || entry.digest === REMOVED) return 0;
    const hash = createHash("sha256");
    let at = 0;
    let verified = 0;
    for (const [size, digest] of entry.checkpoints) {
      if (size > bytes.byteLength || size < at) break;
      hash.update(bytes.subarray(at, size));
      at = size;
      if (hash.copy().digest("hex") !== digest) break;
      verified = size;
    }
    return verified;
  }

  /** Takes `rel` as it is now as the engine's (a human vouched for it, e.g. by resuming). */
  accept(rel: string): void {
    const bytes = readOrNull(this.abs(rel));
    if (bytes === null) {
      const removed: Entry = { size: 0, digest: REMOVED, checkpoints: [[0, REMOVED]] };
      this.entries.set(rel, removed);
      this.persist(rel, removed, "r");
      return;
    }
    const hash = createHash("sha256").update(bytes);
    const digest = hash.copy().digest("hex");
    const entry: Entry = {
      size: bytes.byteLength,
      digest,
      hash,
      checkpoints: [[bytes.byteLength, digest]],
    };
    this.entries.set(rel, entry);
    this.persist(rel, entry, "w");
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
