import {
  FactRowSchema,
  parsePersisted,
  type FactLocator,
  type FactRow,
  type FactStatus,
  type FactValue,
  type VtcEvent,
} from "@vtc/shared";
import { eventsOfType, webUrl } from "./events";
import type { StatusMeta } from "./states";

/**
 * Research facts (spec §8.2, §10; spine AD-22): the rows of `.vtc/research/facts.jsonl`, read
 * through the artifacts route. Rows are appended and superseded, never edited, so the view shows
 * the current row of each fact; the engine decides every status (only code resolving the
 * locator against the cached source makes a fact `verified`).
 */
export const FACTS_ORDER: readonly FactStatus[] = [
  "unverified",
  "conflicting",
  "stale",
  "waived",
  "verified",
];

const STATUS: Readonly<Record<FactStatus, StatusMeta>> = {
  unverified: { label: "Unverified", tone: "danger" },
  conflicting: { label: "Conflicting", tone: "danger" },
  stale: { label: "Stale", tone: "warn" },
  waived: { label: "Waived", tone: "neutral" },
  verified: { label: "Verified", tone: "ok" },
};

export const factStatusMeta = (status: FactStatus): StatusMeta => STATUS[status];

export interface FactsFile {
  readonly rows: readonly FactRow[];
  /** 1-based numbers of lines that are not a `FactRow` (shown, never guessed at). */
  readonly invalid: readonly number[];
}

/** Every `FactRow` line; keys a newer engine added are dropped (AD-3 rule 2). */
export const parseFactsJsonl = (text: string): FactsFile => {
  const rows: FactRow[] = [];
  const invalid: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      invalid.push(i + 1);
      return;
    }
    const parsed = parsePersisted(FactRowSchema, raw);
    if (parsed.success) rows.push(parsed.data);
    else invalid.push(i + 1);
  });
  return { rows, invalid };
};

export interface FactView {
  readonly id: string;
  readonly subject: string;
  readonly predicate: string;
  readonly value: string;
  readonly statusId: FactStatus;
  readonly status: StatusMeta;
  readonly source: {
    readonly fetcher: string;
    readonly url: string;
    /** `null` unless the URL is http(s). */
    readonly href: string | null;
    readonly retrievedAt: string;
    readonly locator: string;
  } | null;
  readonly pinnedVersion: string | null;
  readonly expiresAt: string | null;
  readonly recordedBy: string;
  readonly recordedAt: string;
  /** How many earlier rows this one superseded. */
  readonly replaced: number;
  /** The human's reason, when a `fact.waived` event waived it. */
  readonly waiver: string | null;
}

const valueText = (value: FactValue): string => (value === null ? "none" : String(value));

const locatorText = (locator: FactLocator): string =>
  locator.kind === "json_pointer"
    ? `JSON pointer ${locator.pointer === "" ? "(whole document)" : locator.pointer}`
    : `quote “${locator.text.length > 80 ? `${locator.text.slice(0, 80)}…` : locator.text}”`;

const chainLength = (row: FactRow, byId: ReadonlyMap<string, FactRow>): number => {
  let n = 0;
  const seen = new Set<string>();
  for (let id = row.supersedes; id !== undefined && !seen.has(id); n += 1) {
    seen.add(id);
    id = byId.get(id)?.supersedes;
  }
  return n;
};

/**
 * The current row of every fact (rows no later row supersedes), what needs attention first.
 * `fact.verified` and `fact.waived` events newer than a row update its status, so a waiver
 * recorded at G2 shows with its reason before the file catches up.
 */
export const currentFacts = (
  rows: readonly FactRow[],
  events: readonly VtcEvent[] = [],
): FactView[] => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const superseded = new Set(
    rows.flatMap((r) => (r.supersedes === undefined ? [] : [r.supersedes])),
  );
  const verified = eventsOfType(events, "fact.verified");
  const waived = eventsOfType(events, "fact.waived");
  return rows
    .filter((row) => !superseded.has(row.id))
    .map((row): FactView => {
      let status: FactStatus = row.status;
      let waiver: string | null = null;
      const after = (ts: string): boolean => Date.parse(ts) > Date.parse(row.recorded_at);
      // Events are oldest first: the last one that applies wins.
      for (const e of [...verified, ...waived].sort((a, b) => a.event.seq - b.event.seq)) {
        if (e.data.id !== row.id || !after(e.event.ts)) continue;
        if ("status" in e.data) {
          status = e.data.status;
        } else {
          status = "waived";
          waiver = e.data.reason;
        }
      }
      return {
        id: row.id,
        subject: row.subject,
        predicate: row.predicate,
        value: valueText(row.value),
        statusId: status,
        status: STATUS[status],
        source:
          row.source === null
            ? null
            : {
                fetcher: row.source.fetcher,
                url: row.source.url,
                href: webUrl(row.source.url),
                retrievedAt: row.source.retrieved_at,
                locator: locatorText(row.source.locator),
              },
        pinnedVersion: row.pinned_version ?? null,
        expiresAt: row.expires_at ?? null,
        recordedBy: row.recorded_by,
        recordedAt: row.recorded_at,
        replaced: chainLength(row, byId),
        waiver: status === "waived" ? waiver : null,
      };
    })
    .sort(
      (a, b) =>
        FACTS_ORDER.indexOf(a.statusId) - FACTS_ORDER.indexOf(b.statusId) ||
        a.subject.localeCompare(b.subject) ||
        a.predicate.localeCompare(b.predicate),
    );
};

/** How many current facts have each status, in {@link FACTS_ORDER}. */
export const factCounts = (facts: readonly FactView[]): { status: StatusMeta; n: number }[] =>
  FACTS_ORDER.map((s) => ({
    status: STATUS[s],
    n: facts.filter((f) => f.statusId === s).length,
  })).filter((c) => c.n > 0);
