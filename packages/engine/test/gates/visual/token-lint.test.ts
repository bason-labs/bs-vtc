import { describe, expect, it } from "vitest";
import { ToolFindingSchema } from "@vtc/shared";
import { addedLinesWithNumbers } from "../../../src/gates/visual/diff-lines.js";
import { isUiSource, tokenLint } from "../../../src/gates/visual/token-lint.js";
import { EMPTY_TOKENS, parseDesignTokens } from "../../../src/gates/visual/tokens.js";

const tokens = parseDesignTokens(
  JSON.stringify({
    color: { $type: "color", ink: { $value: "#111111" }, brand: { $value: "#3355ff" } },
    space: { $type: "dimension", s: { $value: "8px" }, m: { $value: "16px" } },
    radius: { $type: "dimension", card: { $value: "6px" } },
    font: { body: { $type: "fontFamily", $value: "Söhne" } },
    shadow: {
      $type: "shadow",
      low: {
        $value: { color: "#000000", offsetX: "0px", offsetY: "1px", blur: "2px", spread: "0px" },
      },
    },
  }),
);

const diffOf = (path: string, lines: readonly string[]): string =>
  [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,1 +1,${String(lines.length + 1)} @@`,
    " unchanged",
    ...lines.map((l) => `+${l}`),
  ].join("\n");

const lint = (path: string, lines: readonly string[]) =>
  tokenLint(addedLinesWithNumbers(diffOf(path, lines)), tokens, { colorDelta: 0.02 });

describe("added lines", () => {
  it("numbers added lines in the new file across hunks", () => {
    const diff = [
      "--- a/x.css",
      "+++ b/x.css",
      "@@ -1,3 +1,4 @@",
      " a",
      "-b",
      "+c",
      "+d",
      " e",
      "@@ -10,1 +11,2 @@",
      " f",
      "+g",
      "--- a/gone.css",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-x",
    ].join("\n");
    expect([...addedLinesWithNumbers(diff)]).toEqual([
      [
        "x.css",
        [
          { line: 2, text: "c" },
          { line: 3, text: "d" },
          { line: 12, text: "g" },
        ],
      ],
    ]);
  });
});

describe("token lint", () => {
  it("flags literal colours, lengths, radii, fonts and shadows that are not tokens", () => {
    const findings = lint("src/card.css", [
      ".card { color: #ff0000; padding: 13px 8px; border-radius: 7px; }",
      ".x { font-family: 'Inter', sans-serif; box-shadow: 0 4px 30px rgba(0,0,0,.5); }",
    ]);
    expect(findings.map((f) => [f.rule_id, f.location.line])).toEqual([
      ["vtc-token/color", 2],
      ["vtc-token/length", 2],
      ["vtc-token/radius", 2],
      ["vtc-token/font", 3],
      ["vtc-token/shadow", 3],
    ]);
    for (const f of findings) {
      expect(ToolFindingSchema.parse(f)).toEqual(f);
      expect(f.category).toBe("design");
      expect(f.evidence).toEqual({
        type: "file_line",
        ref: `src/card.css:${String(f.location.line)}`,
      });
    }
  });

  it("accepts token values, near colours, custom properties and var()", () => {
    expect(
      lint("src/ok.css", [
        ".a { color: #111; background: #3356ff; padding: 8px 16px; margin: 0; }",
        ":root { --brand: #abcdef; }",
        ".b { color: var(--brand); border-radius: 6px; border-radius: 9999px; }",
        ".c { font-family: Söhne, system-ui; box-shadow: none; }",
      ]),
    ).toEqual([]);
  });

  it("reads Tailwind arbitrary values and CSS-in-JS in components, not prose", () => {
    const findings = lint("src/Card.tsx", [
      '<div className="bg-[#00ff00] p-[13px] rounded-[6px] text-ink">Pay #42 in red</div>',
      'const s = { backgroundColor: "#00ff00", padding: "8px" };',
      "// color: #ff0000 in a comment",
    ]);
    expect(findings.map((f) => [f.rule_id, f.snippet?.slice(0, 9)])).toEqual([
      ["vtc-token/color", "<div clas"],
      ["vtc-token/length", "<div clas"],
      ["vtc-token/color", "const s ="],
    ]);
  });

  it("does not judge a kind the tokens do not define, and skips non-UI files", () => {
    expect(
      tokenLint(addedLinesWithNumbers(diffOf("a.css", [".a { color: red; }"])), EMPTY_TOKENS, {
        colorDelta: 0.02,
      }),
    ).toEqual([]);
    expect(lint("src/util.ts", ['const c = "#ff0000";'])).toEqual([]);
    expect(isUiSource(".vtc/design/prototype/index.html")).toBe(false);
    expect(isUiSource("web/index.html")).toBe(true);
  });
});
