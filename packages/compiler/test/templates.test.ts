/**
 * The automatic PR, issue and CHANGELOG templates (AD-27 rules 3 and 5; spine §5 readings 190,
 * 198 and 208): Markdown with `{{slot}}` placeholders from `AUTO_TEMPLATE_SLOTS`, compiled into
 * both plugins at `autoTemplateAssetPath`, rendered by the upstream module.
 */
import { describe, expect, it } from "vitest";
import * as shared from "@vtc/shared";
import {
  AUTO_TEMPLATE_NAMES,
  AUTO_TEMPLATE_SLOTS,
  autoTemplateAssetPath,
  HOST_IDS,
  ROLES_CHANGELOG,
} from "@vtc/shared";
import {
  AUTO_TEMPLATE_LAYOUT,
  AUTO_TEMPLATE_SOURCE_DIR,
  autoTemplateErrors,
  compilePlugins,
  ROLES_CHANGELOG_ANCHOR,
  type CompileOutput,
} from "../src/index.js";
import { fixtureFiles } from "./fixtures.js";

const PR_ORDER = [
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
];

const compileOk = (overrides: Readonly<Record<string, string | null>> = {}): CompileOutput => {
  const result = compilePlugins(fixtureFiles(overrides));
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  return result.output;
};

const sourcePath = (name: string): string => `${AUTO_TEMPLATE_SOURCE_DIR}/${name}.md`;

describe("autoTemplateErrors", () => {
  const pr = (slots: readonly string[]): string => slots.map((slot) => `{{${slot}}}`).join("\n\n");

  it("accepts the PR layout in the order of spine §5 reading 208", () => {
    expect(AUTO_TEMPLATE_LAYOUT["auto-pr"]).toEqual(PR_ORDER);
    expect(autoTemplateErrors("auto-pr", pr(PR_ORDER))).toEqual([]);
  });

  it("follows the order of AUTO_TEMPLATE_SLOTS in every layout (reading 208 (5))", () => {
    for (const name of AUTO_TEMPLATE_NAMES) {
      const at = AUTO_TEMPLATE_LAYOUT[name].map((slot) => AUTO_TEMPLATE_SLOTS.indexOf(slot));
      expect(at, name).toEqual([...at].sort((a, b) => a - b));
    }
    expect(AUTO_TEMPLATE_LAYOUT["auto-pr"]).not.toContain("diff");
  });

  it("refuses a block slot that shares its line with other text", () => {
    expect(autoTemplateErrors("auto-pr", pr(PR_ORDER).replace("{{why}}", "Why: {{why}}"))).toEqual([
      "{{why}} must stand on a line of its own: its value can span several lines",
    ]);
    expect(
      autoTemplateErrors(
        "changelog-entry",
        "### {{title}}\n\n{{hypothesis}}\n{{trace_ids}}\n{{diff}}\n**Evaluation:** {{evaluation}}\n",
      ),
    ).toEqual(["{{evaluation}} must stand on a line of its own: its value can span several lines"]);
  });

  it("lets the one-line slots sit inside a line", () => {
    expect(
      autoTemplateErrors(
        "changelog-entry",
        "### {{title}}\n\n- **Hypothesis:** {{hypothesis}}\n- **Trace ids:** {{trace_ids}}\n\n{{diff}}\n\n{{evaluation}}\n",
      ),
    ).toEqual([]);
  });

  it("refuses a slot outside AUTO_TEMPLATE_SLOTS, and a malformed one", () => {
    expect(autoTemplateErrors("auto-pr", `${pr(PR_ORDER)}\n{{repo_name}}`)).toEqual([
      "unknown slot {{repo_name}}; templates use only AUTO_TEMPLATE_SLOTS",
    ]);
    expect(autoTemplateErrors("auto-pr", `${pr(PR_ORDER)}\n{{ summary }}`)).toEqual([
      "unknown slot {{ summary }}; templates use only AUTO_TEMPLATE_SLOTS",
    ]);
  });

  it("refuses a missing, repeated or reordered slot", () => {
    expect(autoTemplateErrors("auto-pr", pr(PR_ORDER.filter((s) => s !== "risk")))).toContain(
      "slots must be, in order: " + PR_ORDER.map((s) => `{{${s}}}`).join(", "),
    );
    expect(autoTemplateErrors("auto-pr", pr([...PR_ORDER, "summary"]))).not.toEqual([]);
    const swapped = [...PR_ORDER];
    [swapped[2], swapped[3]] = [swapped[3] ?? "", swapped[2] ?? ""];
    expect(autoTemplateErrors("auto-pr", pr(swapped))).not.toEqual([]);
  });

  it("refuses a body that does not start with the marker", () => {
    expect(autoTemplateErrors("auto-pr", `# Title\n\n${pr(PR_ORDER)}`)).toContain(
      "the first line must be {{marker}} (AD-27 rule 3: every body starts with the marker)",
    );
  });

  it("refuses a note that does not follow the marker directly", () => {
    const text = pr(PR_ORDER).replace("{{note}}", "Opened by VTC.\n\n{{note}}");
    expect(autoTemplateErrors("auto-pr", text)).toEqual([
      "{{note}} must follow {{marker}} directly: the note comes before anything else",
    ]);
  });

  it("refuses a template that opens its own NOTE callout around the note", () => {
    for (const name of ["auto-pr", "auto-issue"] as const) {
      const base = name === "auto-pr" ? pr(PR_ORDER) : pr(AUTO_TEMPLATE_LAYOUT["auto-issue"]);
      const text = base.replace("{{note}}", "{{note}}\n> [!NOTE]\n> Raised automatically.");
      expect(autoTemplateErrors(name, text), name).toEqual([
        "the template opens no NOTE callout: the {{note}} value is the whole callout",
      ]);
    }
  });

  it("refuses provenance inside a <details> block of the template's own", () => {
    const text = pr(PR_ORDER).replace(
      "{{provenance}}",
      "<details>\n<summary>Provenance</summary>\n\n{{provenance}}\n\n</details>",
    );
    expect(autoTemplateErrors("auto-pr", text)).toEqual([
      "{{provenance}} stands outside any <details> block: its value is the whole block",
    ]);
    const closed = pr(PR_ORDER).replace("{{why}}", "{{why}}\n\n<details>\nx\n</details>");
    expect(autoTemplateErrors("auto-pr", closed)).toEqual([]);
  });
});

describe("the templates compile into both plugins", () => {
  it.each(HOST_IDS)("%s carries every template at autoTemplateAssetPath", (host) => {
    const output = compileOk();
    for (const name of AUTO_TEMPLATE_NAMES) {
      const emitted = output.targets[host].find((f) => f.path === autoTemplateAssetPath(name));
      expect(emitted?.text, name).toBe(
        fixtureFiles().find((f) => f.path === sourcePath(name))?.text,
      );
    }
  });

  it("refuses a missing template", () => {
    const result = compilePlugins(fixtureFiles({ [sourcePath("auto-issue")]: null }));
    expect(result.ok ? [] : result.errors).toContainEqual({
      path: sourcePath("auto-issue"),
      message: "required file is missing",
    });
  });

  it("refuses an unknown template and a template with a slot outside the list", () => {
    const result = compilePlugins(
      fixtureFiles({
        [`${AUTO_TEMPLATE_SOURCE_DIR}/release.md`]: "{{marker}}\n",
        [sourcePath("changelog-entry")]:
          "### {{title}}\n\n{{hypothesis}}\n{{trace_ids}}\n{{diff}}\n{{evaluation}}\n{{client}}\n",
      }),
    );
    const errors = result.ok ? [] : result.errors;
    expect(errors).toContainEqual({
      path: `${AUTO_TEMPLATE_SOURCE_DIR}/release.md`,
      message: `unknown template; the templates are ${AUTO_TEMPLATE_NAMES.join(", ")}`,
    });
    expect(errors).toContainEqual({
      path: sourcePath("changelog-entry"),
      message: "unknown slot {{client}}; templates use only AUTO_TEMPLATE_SLOTS",
    });
  });

  it("uses only slots from the shared list in every layout", () => {
    for (const name of AUTO_TEMPLATE_NAMES) {
      for (const slot of AUTO_TEMPLATE_LAYOUT[name]) {
        expect(AUTO_TEMPLATE_SLOTS as readonly string[], `${name}: ${slot}`).toContain(slot);
      }
    }
  });

  it("lets the CHANGELOG through the layout check", () => {
    expect(ROLES_CHANGELOG).toBe("roles/CHANGELOG.md");
    const result = compilePlugins(
      fixtureFiles({ [ROLES_CHANGELOG]: `# Role prompt changes\n\n${ROLES_CHANGELOG_ANCHOR}\n` }),
    );
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});

describe("the CHANGELOG entry anchor (D-bv)", () => {
  const errorsFor = (text: string | null): { path: string; message: string }[] => {
    const result = compilePlugins(fixtureFiles({ [ROLES_CHANGELOG]: text }));
    return result.ok ? [] : result.errors.filter((e) => e.path === ROLES_CHANGELOG);
  };

  it("is the hidden line the upstream module inserts below", () => {
    expect(ROLES_CHANGELOG_ANCHOR).toBe("<!-- vtc:changelog-entries -->");
    expect(errorsFor(`# Changes\n\n${ROLES_CHANGELOG_ANCHOR}\n\n### entry\n`)).toEqual([]);
  });

  it("is still local: @vtc/shared has no anchor constant yet (contract proposal)", () => {
    // When this fails, the proposed shared ROLES_CHANGELOG_ANCHOR has landed: import it in
    // templates.ts instead of the local copy and drop this test and the todo below.
    expect(Object.keys(shared)).not.toContain("ROLES_CHANGELOG_ANCHOR");
  });
  it.todo(
    "merge gate: ROLES_CHANGELOG_ANCHOR comes from @vtc/shared and upstream's insertChangelogEntry inserts below it (contract proposal)",
  );

  it("requires roles/CHANGELOG.md", () => {
    expect(errorsFor(null)).toEqual([
      { path: ROLES_CHANGELOG, message: "required file is missing" },
    ]);
  });

  it.each([
    ["no anchor", "# Changes\n", 0],
    ["two anchors", `${ROLES_CHANGELOG_ANCHOR}\n${ROLES_CHANGELOG_ANCHOR}\n`, 2],
    ["an anchor inside other text", `see ${ROLES_CHANGELOG_ANCHOR} here\n`, 1],
  ])("refuses a CHANGELOG with %s", (_name, text, found) => {
    expect(errorsFor(text)).toEqual([
      {
        path: ROLES_CHANGELOG,
        message: `must hold the entry anchor ${ROLES_CHANGELOG_ANCHOR} exactly once, on its own line (found ${String(found)})`,
      },
    ]);
  });
});
