/**
 * Reading the frozen spec (§5.2 BA output): requirement and acceptance-criterion ids with their
 * text, for task packs (§6.3 step 1), the Spec-Verifier's one call per AC (§7.4) and the
 * coverage check at PLAN (§6.1). Pure: works on the spec's text.
 *
 * Recognised lines: a heading `## REQ-2 Title` (the requirement) and an item
 * `- REQ-2.AC-1: Given … When … Then …` (an acceptance criterion); `SEC-n` likewise.
 */

export interface SpecItem {
  readonly id: string;
  readonly text: string;
}

const HEADING = /^#{1,6}\s+((?:REQ|SEC)-[1-9]\d*)\b[\s:.-]*(.*)$/;
const ITEM = /^\s*(?:[-*+]\s+)?(?:\*\*)?((?:REQ|SEC)-[1-9]\d*(?:\.AC-[1-9]\d*)?)(?:\*\*)?\s*[:.)-]\s*(.+)$/;

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
    if (item?.[1] !== undefined && item[2] !== undefined) {
      if (!items.has(item[1])) items.set(item[1], item[2].trim());
      continue;
    }
    // The first prose line under a heading becomes the requirement's text.
    if (current !== undefined && raw.trim() !== "" && items.get(current) === current) {
      items.set(current, raw.trim());
    }
  }
  return [...items.entries()].map(([id, itemText]) => ({ id, text: itemText.slice(0, 4000) }));
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
