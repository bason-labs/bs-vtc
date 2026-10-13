/**
 * `roles/<role>/prompt.md` sections (§5.1, §13). The locked core is human-only (a change is a
 * MAJOR prompt version); the editable section is what Lookback may propose changes to (MINOR).
 * The compiler rejects a prompt whose markers are missing, repeated or out of order.
 */

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
