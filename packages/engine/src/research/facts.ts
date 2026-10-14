/**
 * `.vtc/research/facts.jsonl` (AD-22 rule 3): git-tracked, redacted and append-only. A row is
 * never edited: a new status for the same claim is a new row with the same id (the newest row of
 * an id wins), and a new claim that replaces another names it in `supersedes`.
 */
import {
  factId,
  FactRowSchema,
  parsePersisted,
  redactJson,
  RESEARCH_FACTS_FILE,
  type FactRow,
} from "@vtc/shared";
import { join } from "node:path";
import { appendLines, parseJsonLines, readTextIfExists } from "./files.js";

export interface FactsFile {
  readonly rows: FactRow[];
  /** 1-based lines that did not parse or validate (skipped, never fatal). */
  readonly invalidLines: number[];
}

/** Every row of the project's facts file, oldest first. */
export const readFactRows = async (projectRoot: string): Promise<FactsFile> => {
  const text = await readTextIfExists(join(projectRoot, RESEARCH_FACTS_FILE));
  if (text === undefined) return { rows: [], invalidLines: [] };
  const { values, invalid } = parseJsonLines(text);
  const rows: FactRow[] = [];
  const invalidLines = [...invalid];
  for (const { line, value } of values) {
    const parsed = parsePersisted(FactRowSchema, value);
    if (parsed.success) rows.push(parsed.data);
    else invalidLines.push(line);
  }
  return { rows, invalidLines: invalidLines.sort((a, b) => a - b) };
};

/** Appends rows, validated and redacted (known secret values plus every token format). */
export const appendFactRows = async (
  projectRoot: string,
  rows: readonly FactRow[],
  knownValues: readonly string[] = [],
): Promise<FactRow[]> => {
  const written = rows.map((row) =>
    FactRowSchema.parse(redactJson(FactRowSchema.parse(row), knownValues)),
  );
  await appendLines(
    join(projectRoot, RESEARCH_FACTS_FILE),
    written.map((row) => JSON.stringify(row)),
  );
  return written;
};

/**
 * The rows that keep to their id. A fact id is the hash of its claim (`factId`: subject,
 * predicate, value and source URL), so a row whose fields do not hash to its id is a hand-edited
 * or planted row and is dropped: a row can never take over another claim's id (and with it the
 * citations of that id or its status).
 */
export const consistentFactRows = (rows: readonly FactRow[]): FactRow[] =>
  rows.filter(
    (row) => row.id === factId(row.subject, row.predicate, row.value, row.source?.url ?? null),
  );

/**
 * Whether `row` may replace `replaced`: the same subject and predicate from the same source URL
 * (the source now says something else). A row cannot supersede a claim of another source.
 */
const replacesSameSource = (row: FactRow, replaced: FactRow): boolean =>
  row.source !== null &&
  replaced.source !== null &&
  row.source.url === replaced.source.url &&
  row.subject === replaced.subject &&
  row.predicate === replaced.predicate;

/**
 * The current facts: the newest row of each id ({@link consistentFactRows} only), without ids a
 * later row superseded. A `supersedes` counts only when the superseding row replaces the same
 * source's claim and `honours` accepts it (G2 accepts only a row that verifies against the cache).
 * Order: by the position of each id's newest row.
 */
export const currentFacts = (
  rows: readonly FactRow[],
  honours: (row: FactRow) => boolean = () => true,
): FactRow[] => {
  const newest = new Map<string, { row: FactRow; at: number }>();
  const supersededAt = new Map<string, number>();
  consistentFactRows(rows).forEach((row, at) => {
    if (row.supersedes !== undefined && row.supersedes !== row.id) {
      const replaced = newest.get(row.supersedes)?.row;
      if (replaced !== undefined && replacesSameSource(row, replaced) && honours(row))
        supersededAt.set(row.supersedes, at);
    }
    newest.set(row.id, { row, at });
  });
  // A claim recorded again after it was superseded is current again.
  return [...newest.values()]
    .filter(({ row, at }) => (supersededAt.get(row.id) ?? -1) < at)
    .sort((a, b) => a.at - b.at)
    .map(({ row }) => row);
};
