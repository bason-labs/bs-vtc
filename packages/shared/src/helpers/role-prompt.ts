/**
 * `roles/<role>/prompt.md` sections (§5.1, §13). The locked core is human-only (a change is a
 * MAJOR prompt version); the editable section is what Lookback may propose changes to (MINOR).
 * The compiler rejects a prompt whose markers are missing, repeated or out of order.
 */
import { TASK_PACK_HEURISTICS_SECTION, TASK_PACK_SECTIONS } from "../task-pack.js";

export const PROMPT_MARKERS = {
  locked: "<!-- vtc:locked -->",
  editable: "<!-- vtc:editable -->",
} as const;

export type RolePromptSplit =
  | { readonly ok: true; readonly locked: string; readonly editable: string }
  | { readonly ok: false; readonly errors: readonly string[] };

const count = (text: string, marker: string): number => text.split(marker).length - 1;

/**
 * Splits a prompt into its locked core and editable section. Layout: the locked marker on the
 * first non-blank line, then the locked core, then the editable marker on its own line, then
 * the editable section to the end of the file. Both sections must be non-empty.
 */
export const splitRolePrompt = (text: string): RolePromptSplit => {
  const errors: string[] = [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lockedCount = count(normalized, PROMPT_MARKERS.locked);
  const editableCount = count(normalized, PROMPT_MARKERS.editable);
  if (lockedCount !== 1)
    errors.push(`expected exactly one ${PROMPT_MARKERS.locked}, found ${String(lockedCount)}`);
  if (editableCount !== 1) {
    errors.push(`expected exactly one ${PROMPT_MARKERS.editable}, found ${String(editableCount)}`);
  }
  if (errors.length > 0) return { ok: false, errors };
  const lines = normalized.split("\n");
  const firstContent = lines.findIndex((line) => line.trim() !== "");
  const lockedLine = lines.findIndex((line) => line.trim() === PROMPT_MARKERS.locked);
  const editableLine = lines.findIndex((line) => line.trim() === PROMPT_MARKERS.editable);
  if (lockedLine === -1 || editableLine === -1) {
    return { ok: false, errors: ["section markers must each stand on their own line"] };
  }
  if (lockedLine !== firstContent)
    errors.push("the locked marker must be the first non-blank line");
  if (editableLine < lockedLine)
    errors.push("the editable section must come after the locked core");
  const locked = lines
    .slice(lockedLine + 1, editableLine)
    .join("\n")
    .trim();
  const editable = lines
    .slice(editableLine + 1)
    .join("\n")
    .trim();
  if (locked === "") errors.push("the locked core is empty");
  if (editable === "") errors.push("the editable section is empty");
  return errors.length > 0 ? { ok: false, errors } : { ok: true, locked, editable };
};

/**
 * Headings an editable section may not use: the task pack's sections and its `Role heuristics`
 * section (the section may be rendered first in the pack, spine §5 reading 102). Moved from
 * `@vtc/compiler` in 4.10.0 so the compiler and Lookback's proposal check enforce one rule set
 * (spine §5 reading 175).
 */
export const RESERVED_EDITABLE_HEADINGS: readonly string[] = [
  ...TASK_PACK_SECTIONS,
  TASK_PACK_HEURISTICS_SECTION,
];

const RESERVED_HEADINGS = new Set(RESERVED_EDITABLE_HEADINGS.map((name) => name.toLowerCase()));
const PLACEHOLDER = /\{\{[a-z_]+\}\}/;
const HEADING = /^#{1,6}\s+(.+?)\s*#*\s*$/;

/**
 * Pure (AD-14 rule 4, AD-21): what an editable section may not contain, one message per problem
 * and line; empty = acceptable. The section is one role-level text that a Lookback proposal
 * replaces whole and that the engine may render into the task pack, so it compiles verbatim, the
 * same for every mode and host:
 * - no mode block (`<!-- vtc:mode … -->`): a proposal written for one mode's agent would drop the
 *   other modes' blocks when it replaces the role's section (mode rules belong in the locked core);
 * - no `{{placeholder}}`: the compiled text, its `editable_sha256` and the proposal's text would
 *   differ from the source a promoted proposal replaces;
 * - no heading named after a task-pack section or the pack's heuristics section
 *   ({@link RESERVED_EDITABLE_HEADINGS}): rendered first in the pack, such a heading would blur
 *   where the section ends and the data begins.
 * The compiler runs it on `roles/<role>/prompt.md`; Lookback's `checkProposal` runs it on a
 * proposed section, so a proposal that would fail the compile is refused before replay. New in
 * 4.10.0 (it was `@vtc/compiler`'s; same messages).
 */
export const editableSectionErrors = (section: string): string[] => {
  const errors: string[] = [];
  section.split("\n").forEach((line, index) => {
    const at = `editable section line ${String(index + 1)}`;
    const trimmed = line.trim();
    if (trimmed.startsWith("<!-- vtc:mode")) {
      errors.push(
        `${at}: no mode block in the editable section; Lookback replaces the section whole, so put mode-specific rules in the locked core`,
      );
    }
    const placeholder = PLACEHOLDER.exec(line);
    if (placeholder !== null) {
      errors.push(
        `${at}: no placeholder (${placeholder[0]}) in the editable section; it must compile verbatim`,
      );
    }
    const heading = HEADING.exec(trimmed)?.[1];
    if (heading !== undefined && RESERVED_HEADINGS.has(heading.toLowerCase())) {
      errors.push(`${at}: heading "${heading}" is reserved for the task pack`);
    }
  });
  return errors;
};
