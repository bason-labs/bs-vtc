/**
 * The AD-9 lint rule catches every forbidden form (case-insensitive, string and template
 * literals) and uses the same markers as @vtc/shared; the AD-2 rule keeps Node globals out of
 * @vtc/shared. Rule options are imported from eslint.config.js, so this tests the real config.
 */
import { ESLint, type Linter } from "eslint";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { AD9_FORBIDDEN_MARKERS } from "@vtc/shared";
import {
  AD9_MARKERS,
  AD9_RESTRICTED_SYNTAX,
  SHARED_RESTRICTED_GLOBALS,
} from "../../../eslint.config.js";

const lint = async (code: string, rules: Linter.RulesRecord): Promise<number[]> => {
  const eslint = new ESLint({
    overrideConfigFile: true,
    overrideConfig: [{ files: ["**/*.ts"], languageOptions: { parser: tseslint.parser }, rules }],
  });
  const [result] = await eslint.lintText(code, { filePath: "planted.ts" });
  return (result?.messages ?? []).map((m) => m.line);
};

describe("AD-9 lint rule", () => {
  it("uses exactly the shared deny list", () => {
    expect([...AD9_MARKERS]).toEqual([...AD9_FORBIDDEN_MARKERS]);
  });
  const planted = [
    'export const a = ["claude", "--dangerously-skip-permissions"];',
    'export const b = ["--permission-mode", "bypassPermissions"];',
    'export const c = ["codex", "exec", "--dangerously-bypass-approvals-and-sandbox"];',
    'export const d = ["codex", "--yolo"];',
    "export const e = `--sandbox=danger-full-access`;",
    'export const f = (home: string) => [home, ".claude", ".credentials.json"].join("/");',
    'export const g = (home: string) => [home, ".codex", "auth.json"].join("/");',
    'export const h = ["security", "find-generic-password", "-s", "x"];',
    'export const i = ["security", "-s", "Claude Code-credentials"];',
    'export const j = "/HOME/.CODEX/AUTH.JSON";',
  ];
  it.each(planted.map((code, index) => [index + 1, code] as const))(
    "flags planted line %i",
    async (_line, code) => {
      expect(await lint(code, { "no-restricted-syntax": AD9_RESTRICTED_SYNTAX })).toEqual([1]);
    },
  );
  it("leaves legitimate host arguments alone", async () => {
    const code = [
      'export const a = ["claude", "-p", "--permission-mode", "acceptEdits", "--allowedTools", "Read"];',
      'export const b = ["codex", "exec", "--sandbox", "read-only", "--output-schema", "s.json"];',
      'export const c = [".codex/agents/vtc-qa.toml", ".claude/agents/vtc-qa.md"];',
    ].join("\n");
    expect(await lint(code, { "no-restricted-syntax": AD9_RESTRICTED_SYNTAX })).toEqual([]);
  });
});

describe("AD-2 shared globals rule", () => {
  it("flags Node globals in @vtc/shared", async () => {
    const code = [
      'export const a = Buffer.from("x");',
      "export const b = process.env;",
      "export const c = __dirname;",
      "export const d = setImmediate;",
      "export const ok = new TextEncoder();",
    ].join("\n");
    expect(await lint(code, { "no-restricted-globals": SHARED_RESTRICTED_GLOBALS })).toEqual([
      1, 2, 3, 4,
    ]);
  });
});
