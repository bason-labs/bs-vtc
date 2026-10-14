/**
 * The automatic PR, issue and CHANGELOG templates (AD-27 rules 3 and 5; spine §5 readings 190,
 * 198 and 208). Hand-written Markdown in `plugins/common/templates/<name>.md` with `{{slot}}`
 * placeholders from `AUTO_TEMPLATE_SLOTS`; the compiler checks each one and copies it verbatim
 * into both plugins at `autoTemplateAssetPath(name)`, where the upstream module reads and renders
 * it (filling every slot, or "unavailable"). The compiler never fills a slot itself.
 */
import {
  AUTO_TEMPLATE_NAMES,
  AUTO_TEMPLATE_SLOTS,
  autoTemplateAssetPath,
  ROLES_CHANGELOG,
  type AutoTemplateName,
  type AutoTemplateSlot,
} from "@vtc/shared";
import type { CompileError, EmittedFile, SourceFile } from "./types.js";

/** Where the template sources live, one `<name>.md` per `AUTO_TEMPLATE_NAMES` entry. */
export const AUTO_TEMPLATE_SOURCE_DIR = "plugins/common/templates";

/**
 * What every automatic PR says before its summary (D-bw, AD-27 rule 2), in the template's own
 * words rather than a slot, so no renderer input can drop it. The template opens the NOTE callout
 * (`> [!NOTE]` and this line); the `note` slot stands on the next line and continues it, so its
 * value is the renderer's own `> ` lines (VTC version, AI disclosure, kind, evidence status,
 * `Closes #n`) without a second `[!NOTE]` header.
 */
export const NEVER_MERGES_LINE = "For human review only: VTC never merges automatic PRs.";

/**
 * The slots of each template, each exactly once and in this order. A PR body follows spine §5
 * reading 208: marker, note, summary, why, changes, evidence, verification, risk, provenance,
 * checklist. A prompt PR's editable-section diff (`diff`) closes its Changes section, as its own
 * slot because the renderer drops it first when a body is too long. An issue has no changes,
 * verification, risk or checklist. A CHANGELOG entry (`ROLES_CHANGELOG`, D-bv) records the
 * hypothesis, the trace ids, the diff and the evaluation.
 */
export const AUTO_TEMPLATE_LAYOUT: Readonly<Record<AutoTemplateName, readonly AutoTemplateSlot[]>> =
  {
    "auto-pr": [
      "marker",
      "note",
      "summary",
      "why",
      "changes",
      "diff",
      "evidence",
      "verification",
      "risk",
      "provenance",
      "checklist",
    ],
    "auto-issue": ["marker", "note", "summary", "why", "evidence", "provenance"],
    "changelog-entry": ["title", "hypothesis", "trace_ids", "diff", "evaluation"],
  };

const SLOT = /\{\{([^{}]*)\}\}/g;
const KNOWN: ReadonlySet<string> = new Set(AUTO_TEMPLATE_SLOTS);

/**
 * The slots whose value is one line, so a template may put them inside a line (a heading, a
 * bullet). Every other slot can hold several lines (a table, a fenced diff, the NOTE's own `> `
 * lines), so it must stand on a line of its own or its value would not render.
 */
export const INLINE_TEMPLATE_SLOTS: ReadonlySet<AutoTemplateSlot> = new Set([
  "title",
  "hypothesis",
  "trace_ids",
]);

/** Pure: what is wrong with one template's text; empty = acceptable. */
export const autoTemplateErrors = (name: AutoTemplateName, text: string): string[] => {
  const errors: string[] = [];
  const layout = AUTO_TEMPLATE_LAYOUT[name];
  const used: { readonly slot: string; readonly at: number }[] = [];
  for (const match of text.matchAll(SLOT)) {
    const slot = match[1] ?? "";
    if (KNOWN.has(slot)) used.push({ slot, at: match.index });
    else errors.push(`unknown slot ${match[0]}; templates use only AUTO_TEMPLATE_SLOTS`);
  }
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(SLOT)) {
      const slot = match[1] ?? "";
      if (KNOWN.has(slot) && !INLINE_TEMPLATE_SLOTS.has(slot as AutoTemplateSlot)) {
        if (line.trim() !== match[0]) {
          errors.push(
            `${match[0]} must stand on a line of its own: its value can span several lines`,
          );
        }
      }
    }
  }
  if (used.map((u) => u.slot).join(",") !== layout.join(",")) {
    errors.push(`slots must be, in order: ${layout.map((s) => `{{${s}}}`).join(", ")}`);
  }
  if (layout[0] === "marker" && text.split("\n").find((l) => l.trim() !== "") !== "{{marker}}") {
    errors.push(
      "the first line must be {{marker}} (AD-27 rule 3: every body starts with the marker)",
    );
  }
  if (name === "auto-pr") {
    const summary = text.indexOf("{{summary}}");
    const before = summary === -1 ? text : text.slice(0, summary);
    if (!before.includes(NEVER_MERGES_LINE)) {
      errors.push(`the note must say "${NEVER_MERGES_LINE}" before {{summary}} (D-bw)`);
    }
  }
  const provenance = text.indexOf("{{provenance}}");
  if (layout.includes("provenance") && provenance !== -1) {
    const open = text.lastIndexOf("<details>", provenance);
    const closedBefore = text.lastIndexOf("</details>", provenance);
    const close = text.indexOf("</details>", provenance);
    if (open === -1 || closedBefore > open || close === -1) {
      errors.push("{{provenance}} must sit inside a <details> block");
    }
  }
  return errors;
};

const isTemplateName = (name: string): name is AutoTemplateName =>
  (AUTO_TEMPLATE_NAMES as readonly string[]).includes(name);

/**
 * The template files every plugin carries, checked: each of `AUTO_TEMPLATE_NAMES` is required, an
 * unknown file in the template directory is an error, and each template passes
 * {@link autoTemplateErrors}.
 */
export const autoTemplateFiles = (
  files: readonly SourceFile[],
  errors: CompileError[],
): EmittedFile[] => {
  const prefix = `${AUTO_TEMPLATE_SOURCE_DIR}/`;
  for (const file of files.filter((f) => f.path.startsWith(prefix))) {
    const name = file.path.slice(prefix.length).replace(/\.md$/, "");
    if (!file.path.endsWith(".md") || !isTemplateName(name)) {
      errors.push({
        path: file.path,
        message: `unknown template; the templates are ${AUTO_TEMPLATE_NAMES.join(", ")}`,
      });
    }
  }
  const emitted: EmittedFile[] = [];
  for (const name of AUTO_TEMPLATE_NAMES) {
    const path = `${prefix}${name}.md`;
    const source = files.find((f) => f.path === path);
    if (source === undefined) {
      errors.push({ path, message: "required file is missing" });
      continue;
    }
    for (const message of autoTemplateErrors(name, source.text)) errors.push({ path, message });
    emitted.push({ path: autoTemplateAssetPath(name), text: source.text });
  }
  return emitted;
};

/**
 * The line in `roles/CHANGELOG.md` (`ROLES_CHANGELOG`) directly below which the upstream module
 * inserts each new entry, newest first (D-bv). Local until the proposed shared constant lands.
 */
export const ROLES_CHANGELOG_ANCHOR = "<!-- vtc:changelog-entries -->";

/**
 * Checks `roles/CHANGELOG.md`: it is required and holds {@link ROLES_CHANGELOG_ANCHOR} exactly
 * once, on a line of its own, so the upstream module always finds one insertion point.
 */
export const checkRolesChangelog = (files: readonly SourceFile[], errors: CompileError[]): void => {
  const source = files.find((f) => f.path === ROLES_CHANGELOG);
  if (source === undefined) {
    errors.push({ path: ROLES_CHANGELOG, message: "required file is missing" });
    return;
  }
  const lines = source.text.split("\n").filter((line) => line.includes(ROLES_CHANGELOG_ANCHOR));
  if (lines.length !== 1 || lines[0]?.trim() !== ROLES_CHANGELOG_ANCHOR) {
    errors.push({
      path: ROLES_CHANGELOG,
      message: `must hold the entry anchor ${ROLES_CHANGELOG_ANCHOR} exactly once, on its own line (found ${String(lines.length)})`,
    });
  }
};
