/**
 * The local automation ledger (AD-27 rule 4; spine §5 reading 208): one JSON line per thing VTC saw
 * or did for a fingerprint, at `<vtcHome>/guard/_upstream/ledger.jsonl` for VTC's own repo and
 * `<guard dir>/upstream/ledger.jsonl` for a project's repo. The ledger is read back as trusted (the
 * heads VTC pushed, the head a close may delete, the issues VTC's quiet sweep closed), so both
 * live under `<vtcHome>/guard/` (`ROLE_DENIED_VTC.homeWriteDeny` `guard/**`): VTC's own in
 * `upstreamStateDir`, a project's in the engine's private guard dir. Never in the checkout, where
 * roles and gate commands write, nor elsewhere in VTC's home. Append-only, mode 0600, never
 * through a symlink (every directory below the trusted root is checked and the file is opened
 * `O_NOFOLLOW`), every line redacted. It is a cache: the remote label listing is the source of
 * truth for issue and PR state; the ledger holds what the remote cannot tell (occurrences, when VTC
 * last wrote to an issue, which issues VTC's quiet sweep closed, the heads VTC pushed).
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactJson, type AutoKind } from "@vtc/shared";
import { appendNoFollow, ensureDirNoFollow, readNoFollow } from "./safe-fs.js";
import { upstreamStateDir } from "./state-dir.js";

export type LedgerEvent =
  /** One occurrence of the fingerprint (`version`: the VTC release that saw it). */
  | "seen"
  | "issue_opened"
  /** VTC edited the issue body (the occurrence table). */
  | "issue_updated"
  | "commented"
  | "reopened"
  /** VTC's 14-day sweep closed the issue (so a recurrence reopens it). */
  | "closed_quiet"
  | "pr_opened"
  | "pr_closed";

export interface LedgerEntry {
  readonly repo: string;
  readonly fp: string;
  readonly kind: AutoKind;
  readonly event: LedgerEvent;
  readonly at: string;
  readonly number?: number;
  /** `pr_opened`: the head commit VTC pushed (a close deletes the branch only at this head). */
  readonly head?: string;
  readonly version?: string;
}

export interface LedgerRecord {
  readonly repo: string;
  readonly fingerprint: string;
  readonly kind: AutoKind;
  readonly firstSeen: string | null;
  readonly lastSeen: string | null;
  readonly count: number;
  readonly versions: readonly string[];
  readonly issue: number | null;
  readonly pr: number | null;
  readonly prHead: string | null;
  /** Every head VTC pushed for the fingerprint (a branch at one of them holds no human commit). */
  readonly pushedHeads: readonly string[];
  /** The last time VTC wrote to the issue (edit, comment or reopen). */
  readonly lastWriteAt: string | null;
  /** `count` when VTC last commented on (or opened) the issue. */
  readonly countAtComment: number;
  /** `versions` when VTC last commented on (or opened) the issue. */
  readonly versionsAtComment: readonly string[];
  readonly quietClosed: readonly number[];
}

export interface Ledger {
  readonly path: string;
  append(entry: LedgerEntry): void;
  record(repo: string, fingerprint: string): LedgerRecord | undefined;
  /** Issues VTC opened in `repo` from `since` (inclusive). */
  issuesOpenedSince(repo: string, since: Date): number;
}

/** Where a target's ledger lives. */
export const ledgerPath = (
  target:
    | { readonly kind: "upstream"; readonly vtcHome: string }
    | { readonly kind: "project"; readonly guardDir: string },
): string =>
  target.kind === "upstream"
    ? join(upstreamStateDir(target.vtcHome), "ledger.jsonl")
    : join(target.guardDir, "upstream", "ledger.jsonl");

const isEntry = (value: unknown): value is LedgerEntry => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.repo === "string" &&
    typeof v.fp === "string" &&
    typeof v.kind === "string" &&
    typeof v.event === "string" &&
    typeof v.at === "string"
  );
};

const fold = (entries: readonly LedgerEntry[]): LedgerRecord | undefined => {
  const first = entries[0];
  if (first === undefined) return undefined;
  let record: LedgerRecord = {
    repo: first.repo,
    fingerprint: first.fp,
    kind: first.kind,
    firstSeen: null,
    lastSeen: null,
    count: 0,
    versions: [],
    issue: null,
    pr: null,
    prHead: null,
    pushedHeads: [],
    lastWriteAt: null,
    countAtComment: 0,
    versionsAtComment: [],
    quietClosed: [],
  };
  for (const e of entries) {
    switch (e.event) {
      case "seen":
        record = {
          ...record,
          firstSeen: record.firstSeen ?? e.at,
          lastSeen: e.at,
          count: record.count + 1,
          versions:
            e.version === undefined || record.versions.includes(e.version)
              ? record.versions
              : [...record.versions, e.version],
        };
        break;
      case "issue_opened":
        record = {
          ...record,
          issue: e.number ?? record.issue,
          lastWriteAt: e.at,
          countAtComment: record.count,
          versionsAtComment: record.versions,
        };
        break;
      case "issue_updated":
        record = { ...record, lastWriteAt: e.at };
        break;
      case "reopened":
        // A later close of a reopened issue is a human's (not the quiet sweep's) decision.
        record = {
          ...record,
          lastWriteAt: e.at,
          quietClosed: record.quietClosed.filter((n) => n !== e.number),
        };
        break;
      case "commented":
        record = {
          ...record,
          lastWriteAt: e.at,
          countAtComment: record.count,
          versionsAtComment: record.versions,
        };
        break;
      case "closed_quiet":
        record = {
          ...record,
          quietClosed:
            e.number === undefined ? record.quietClosed : [...record.quietClosed, e.number],
        };
        break;
      case "pr_opened":
        record = {
          ...record,
          pr: e.number ?? record.pr,
          prHead: e.head ?? record.prHead,
          pushedHeads:
            e.head === undefined || record.pushedHeads.includes(e.head)
              ? record.pushedHeads
              : [...record.pushedHeads, e.head],
        };
        break;
      case "pr_closed":
        record = { ...record, pr: null, prHead: null };
        break;
    }
  }
  return record;
};

const WHAT = "the automation ledger";

/**
 * Opens (lazily creates) the ledger at `path`; `knownValues` are redacted from every line. With
 * `root` (VTC's home or the engine's guard dir), every directory from it down to the ledger is checked
 * for symlinks; without it only the ledger's own directory is.
 */
export const openLedger = (
  path: string,
  knownValues: readonly string[] = [],
  root?: string,
): Ledger => {
  const entries = (): LedgerEntry[] => {
    const text = readNoFollow(path, WHAT);
    if (text === null) return [];
    return text.split("\n").flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const value: unknown = JSON.parse(line);
        return isEntry(value) ? [value] : [];
      } catch {
        return [];
      }
    });
  };
  const ensureDir = (): void => {
    const dir = dirname(path);
    if (root !== undefined) {
      ensureDirNoFollow(root, dir, WHAT);
      return;
    }
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    ensureDirNoFollow(dirname(dir), dir, WHAT);
  };
  return {
    path,
    append: (entry) => {
      ensureDir();
      appendNoFollow(path, `${JSON.stringify(redactJson(entry, knownValues))}\n`, WHAT);
    },
    record: (repo, fingerprint) =>
      fold(entries().filter((e) => e.repo === repo && e.fp === fingerprint)),
    issuesOpenedSince: (repo, since) =>
      entries().filter(
        (e) => e.repo === repo && e.event === "issue_opened" && Date.parse(e.at) >= since.getTime(),
      ).length,
  };
};
