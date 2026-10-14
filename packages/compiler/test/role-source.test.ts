import { describe, expect, it } from "vitest";
import { PROMPT_MARKERS } from "@vtc/shared";
import { MODE_MARKERS, parseRoleSource, renderTemplate, selectMode } from "../src/index.js";

const roleYaml = (extra = ""): string => `
id: qa
version: 1.0.0
kind: core
mission: Author and judge acceptance tests.
inputs: [spec, task]
output: { artifacts: [], verdicts: [] }
exits: [done, blocked]
reviewer: engine
models:
  claude-code: { tier: mid, effort: medium }
  codex: { tier: mid, effort: medium }
tools: { profile: read_only }
budget: { context_tokens: 30000 }
${extra}`;

const prompt = (locked: string, editable = "Tips."): string =>
  `${PROMPT_MARKERS.locked}\n${locked}\n${PROMPT_MARKERS.editable}\n${editable}\n`;

describe("parseRoleSource", () => {
  it("parses role.yaml and splits prompt.md", () => {
    const result = parseRoleSource({ dir: "qa", roleYaml: roleYaml(), promptMd: prompt("Core.") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.role.id).toBe("qa");
      expect(result.prompt).toEqual({ locked: "Core.", editable: "Tips." });
    }
  });

  it("reports YAML syntax errors", () => {
    const result = parseRoleSource({ dir: "qa", roleYaml: "id: [qa", promptMd: prompt("Core.") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/^role\.yaml:/);
  });

  it("reports contract errors with their path", () => {
    const result = parseRoleSource({
      dir: "qa",
      roleYaml: roleYaml().replace("version: 1.0.0", "version: one"),
      promptMd: prompt("Core."),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("role.yaml: version:");
  });

  it("requires the role id to match its directory", () => {
    const result = parseRoleSource({ dir: "qa2", roleYaml: roleYaml(), promptMd: prompt("C.") });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("directory");
  });

  it("rejects a prompt without the section markers", () => {
    const result = parseRoleSource({ dir: "qa", roleYaml: roleYaml(), promptMd: "# QA\n" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("prompt.md:");
  });

  it("rejects a prompt longer than 150 lines (spec §5.1)", () => {
    const long = Array.from({ length: 151 }, (_, i) => `line ${String(i)}`).join("\n");
    const result = parseRoleSource({ dir: "qa", roleYaml: roleYaml(), promptMd: prompt(long) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("150 lines");
  });

  it("rejects mode blocks for modes the role does not declare", () => {
    const body = `Core.\n${MODE_MARKERS.start("author")}\nAuthor only.\n${MODE_MARKERS.end}`;
    const result = parseRoleSource({ dir: "qa", roleYaml: roleYaml(), promptMd: prompt(body) });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain("author");
  });

  it("accepts mode blocks for declared modes", () => {
    const body = `Core.\n${MODE_MARKERS.start("author")}\nAuthor only.\n${MODE_MARKERS.end}`;
    const result = parseRoleSource({
      dir: "qa",
      roleYaml: roleYaml("modes: { author: {}, judge: {} }"),
      promptMd: prompt(body),
    });
    expect(result.ok).toBe(true);
  });
});

describe("the editable section compiles verbatim (AD-14 rule 4, AD-21)", () => {
  const withModes = roleYaml("modes: { author: {}, judge: {} }");
  const errorsFor = (editable: string, yaml = roleYaml()): string => {
    const result = parseRoleSource({
      dir: "qa",
      roleYaml: yaml,
      promptMd: prompt("Core.", editable),
    });
    return result.ok ? "" : result.errors.join("\n");
  };

  it("rejects a mode block in the editable section, even for a declared mode", () => {
    const editable = `Tips.\n${MODE_MARKERS.start("author")}\nAuthor tip.\n${MODE_MARKERS.end}`;
    expect(errorsFor(editable, withModes)).toMatch(/no mode block in the editable section/);
  });

  it("still accepts mode blocks in the locked core", () => {
    const body = `Core.\n${MODE_MARKERS.start("judge")}\nJudge only.\n${MODE_MARKERS.end}`;
    expect(parseRoleSource({ dir: "qa", roleYaml: withModes, promptMd: prompt(body) }).ok).toBe(
      true,
    );
  });

  it("rejects a placeholder in the editable section", () => {
    expect(errorsFor("Use {{evidence_types}}.")).toMatch(
      /no placeholder \(\{\{evidence_types\}\}\)/,
    );
  });

  it("rejects a heading named after a task-pack section or the heuristics section", () => {
    expect(errorsFor("## Dispatch\n\nrun: x")).toMatch(/heading "Dispatch" is reserved/);
    expect(errorsFor("### role heuristics")).toMatch(/heading "role heuristics" is reserved/);
    expect(errorsFor("## Heuristics\n\n- Tip.")).toBe("");
  });
});

describe("selectMode", () => {
  const text = [
    "Shared.",
    MODE_MARKERS.start("author"),
    "Author rule.",
    MODE_MARKERS.end,
    MODE_MARKERS.start("judge"),
    "Judge rule.",
    MODE_MARKERS.end,
    "Tail.",
  ].join("\n");

  it("keeps the shared text and only the selected mode's blocks", () => {
    expect(selectMode(text, "author", ["author", "judge"])).toEqual({
      ok: true,
      text: "Shared.\nAuthor rule.\nTail.",
    });
    expect(selectMode(text, "judge", ["author", "judge"])).toEqual({
      ok: true,
      text: "Shared.\nJudge rule.\nTail.",
    });
  });

  it("passes text without blocks through unchanged", () => {
    expect(selectMode("Plain.", undefined, [])).toEqual({ ok: true, text: "Plain." });
  });

  it("rejects nested, unterminated and stray markers", () => {
    const nested = [MODE_MARKERS.start("author"), MODE_MARKERS.start("judge"), "x"].join("\n");
    expect(selectMode(nested, "author", ["author", "judge"]).ok).toBe(false);
    expect(selectMode(MODE_MARKERS.start("author"), "author", ["author"]).ok).toBe(false);
    expect(selectMode(MODE_MARKERS.end, "author", ["author"]).ok).toBe(false);
  });

  it("rejects a mode block in a role without modes", () => {
    const result = selectMode(
      `${MODE_MARKERS.start("author")}\nx\n${MODE_MARKERS.end}`,
      undefined,
      [],
    );
    expect(result.ok).toBe(false);
  });
});

describe("renderTemplate", () => {
  it("replaces known placeholders", () => {
    expect(renderTemplate("Types: {{types}}.", { types: "a, b" })).toEqual({
      ok: true,
      text: "Types: a, b.",
    });
  });
  it("rejects unknown placeholders", () => {
    const result = renderTemplate("{{nope}}", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors).toEqual(["unknown placeholder {{nope}}"]);
  });
});
