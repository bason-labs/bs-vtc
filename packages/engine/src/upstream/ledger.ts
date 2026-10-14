/**
 * The local automation ledger (AD-27 rule 4; spine §5 reading 208): one JSON line per thing VTC saw
 * or did for a fingerprint, at `<vtcHome>/upstream/ledger.jsonl` for VTC's own repo and
 * `.vtc/state/automation/ledger.jsonl` (gitignored) for a project. Append-only, mode 0600, never
 * through a symlink, every line redacted. It is a cache: the remote label listing is the source of
 * truth for issue and PR state; the ledger holds what the remote cannot tell (occurrences, when VTC
 * last wrote to an issue, which issues VTC's quiet sweep closed, the head VTC last pushed).
 */
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { redactJson, type AutoKind } from "@vtc/shared";

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
    | { readonly kind: "project"; readonly repoRoot: string },
): string =>
  target.kind === "upstream"
    ? join(target.vtcHome, "upstream", "ledger.jsonl")
    : join(target.repoRoot, ".vtc", "state", "automation", "ledger.jsonl");

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
        record = { ...record, pr: e.number ?? record.pr, prHead: e.head ?? record.prHead };
        break;
      case "pr_closed":
        record = { ...record, pr: null, prHead: null };
        break;
    }
  }
  return record;
};

const refuseSymlink = (path: string): void => {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) {
    throw new Error("the automation ledger is a symlink");
  }
};

/** Opens (lazily creates) the ledger at `path`; `knownValues` are redacted from every line. */
export const openLedger = (path: string, knownValues: readonly string[] = []): Ledger => {
  const entries = (): LedgerEntry[] => {
    refuseSymlink(path);
    if (!existsSync(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line) => {
        if (line.trim() === "") return [];
        try {
          const value: unknown = JSON.parse(line);
          return isEntry(value) ? [value] : [];
        } catch {
          return [];
        }
      });
  };
  return {
    path,
    append: (entry) => {
      refuseSymlink(path);
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      refuseSymlink(dir);
      appendFileSync(path, `${JSON.stringify(redactJson(entry, knownValues))}\n`, {
        mode: 0o600,
        flag: "a",
      });
    },
    record: (repo, fingerprint) =>
      fold(entries().filter((e) => e.repo === repo && e.fp === fingerprint)),
    issuesOpenedSince: (repo, since) =>
      entries().filter(
        (e) => e.repo === repo && e.event === "issue_opened" && Date.parse(e.at) >= since.getTime(),
      ).length,
  };
};
