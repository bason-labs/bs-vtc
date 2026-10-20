/**
 * Reading the frozen spec (§5.2 BA output): requirement and acceptance-criterion ids with their
 * text, for task packs (§6.3 step 1), the Spec-Verifier's one call per AC (§7.4) and the
 * coverage check at PLAN (§6.1). Pure: works on the spec's text.
 *
 * Recognised lines: a heading `## REQ-2 Title` (the requirement) and an item
 * `- REQ-2.AC-1: Given … When … Then …` (an acceptance criterion); `SEC-n` likewise. A bold id
 * may carry an annotation (`**REQ-4** (revised r2) …`); one that withdraws it (`(removed r2)`,
 * `(deferred)`) defines nothing. A REQ that only its ACs name still counts.
 */

export interface SpecItem {
  readonly id: string;
  readonly text: string;
}

const HEADING = /^#{1,6}\s+((?:REQ|SEC)-[1-9]\d*)\b[\s:.-]*(.*)$/;
// The id may be followed by an annotation (`**REQ-4** (revised r2) If …`). A bold id closes its
// bold (a separator may sit inside it: `**REQ-1:** …`) or takes a separator (`**REQ-1: Title**`);
// a plain id needs a separator, so prose like `REQ-1 to REQ-7` defines nothing.
const ID = "(?:REQ|SEC)-[1-9]\\d*(?:\\.AC-[1-9]\\d*)?";
const NOTE = "\\s*(?:\\([^)]*\\))?\\s*";
// An annotation that withdraws the item (`**REQ-9** (removed r2) …`) defines nothing, so a
// requirement the spec dropped cannot block PLAN coverage.
const WITHDRAWN = /\([^)]*\b(?:removed|deleted|dropped|deferred|out of scope)\b[^)]*\)/i;
const ITEM = new RegExp(
  `^\\s*(?:[-*+]\\s+)?(?:\\*\\*(${ID})(?:[:.)-]?\\*\\*${NOTE}[:.)-]?|${NOTE}[:.)-])|(${ID})(?:\\*\\*)?${NOTE}[:.)-])\\s*(.+)$`,
);

/** Every REQ/SEC and AC the spec defines, in document order, first definition wins. */
export const parseSpecItems = (text: string): SpecItem[] => {
  const items = new Map<string, string>();
  let current: string | undefined;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = HEADING.exec(raw);
    if (heading?.[1] !== undefined) {
      current = heading[1];
      if (!items.has(current)) items.set(current, (heading[2] ?? "").trim() || current);
      continue;
    }
    const item = ITEM.exec(raw);
    const itemId = item?.[1] ?? item?.[2];
    if (itemId !== undefined && item?.[3] !== undefined) {
      const head = item[0].slice(0, item[0].length - item[3].length);
      if (!items.has(itemId) && !WITHDRAWN.test(head))
        items.set(itemId, item[3].replace(/\*\*\s*$/, "").trim());
      continue;
    }
    // The first prose line under a heading becomes the requirement's text.
    if (current !== undefined && raw.trim() !== "" && items.get(current) === current) {
      items.set(current, raw.trim());
    }
  }
  // A REQ named only through its ACs (`REQ-7.AC-1`) is still a requirement; its text is its id.
  const entries: [string, string][] = [];
  for (const [id, itemText] of items) {
    const parent = id.includes(".AC-") ? id.slice(0, id.indexOf(".AC-")) : undefined;
    if (parent !== undefined && !items.has(parent) && !entries.some(([e]) => e === parent)) {
      entries.push([parent, parent]);
    }
    entries.push([id, itemText]);
  }
  return entries.map(([id, itemText]) => ({ id, text: itemText.slice(0, 4000) }));
};

/** Requirement ids (`REQ-n`, `SEC-n`) the spec defines. */
export const specRequirementIds = (items: readonly SpecItem[]): string[] =>
  items.filter((i) => !i.id.includes(".AC-")).map((i) => i.id);

/** The ACs of the given requirements, in spec order. */
export const acceptanceCriteriaOf = (
  items: readonly SpecItem[],
  requirements: readonly string[],
): string[] =>
  items
    .filter((i) => i.id.includes(".AC-") && requirements.some((r) => i.id.startsWith(`${r}.`)))
    .map((i) => i.id);
