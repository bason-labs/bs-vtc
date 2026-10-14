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
 * What every automatic PR's note says (D-bw, AD-27 rule 2). The `note` slot's value is the whole
 * NOTE callout, its `> [!NOTE]` header included, and the upstream module's renderer writes it
 * (VTC version, AI disclosure, this sentence in a PR, kind, evidence status, `Closes #n`); a
 * template opens no callout of its own, so a body never carries a second header or the sentence
 * twice. The shared doc line on the `note` slot that pins this is a contract proposal of this
 * branch; the Lead's skill quotes the sentence.
 */
export const NEVER_MERGES_LINE = "For human review only: VTC never merges automatic PRs.";

/**
 * The slots of each template, each exactly once and in this order, which is also their order in
 * `AUTO_TEMPLATE_SLOTS` (spine §5 reading 208 (5)). A PR body: marker, note, summary, why,
 * changes, evidence, verification, risk, provenance, checklist; a prompt PR's diff is in the pull
 * request's own diff and its CHANGELOG entry, not in the body. An issue has no changes,
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
 * bullet). Every other slot can hold several lines (a table, a fenced diff, the NOTE callout, the
 * provenance `<details>` block), so it must stand on a line of its own or its value would not
 * render.
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
  if (layout[1] === "note") {
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    if (lines[1] !== "{{note}}") {
      errors.push("{{note}} must follow {{marker}} directly: the note comes before anything else");
    }
    if (/\[!NOTE\]/i.test(text)) {
      errors.push("the template opens no NOTE callout: the {{note}} value is the whole callout");
    }
  }
  const provenance = text.indexOf("{{provenance}}");
  if (provenance !== -1) {
    const open = text.lastIndexOf("<details>", provenance);
    if (open !== -1 && text.lastIndexOf("</details>", provenance) < open) {
      errors.push(
        "{{provenance}} stands outside any <details> block: its value is the whole block",
      );
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
 * inserts each new entry, newest first (D-bv). Local until the proposed shared constant lands next
 * to `ROLES_CHANGELOG` (a contract proposal of this branch, with the upstream module as its
 * consumer); a todo merge gate in the template tests tracks it.
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
