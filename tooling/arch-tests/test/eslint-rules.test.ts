/**
 * The AD-9 lint rule catches every forbidden form (case-insensitive, string and template
 * literals) and uses the same markers as @vtc/shared; the AD-2 rule keeps Node globals out of
 * @vtc/shared. Rule options are imported from eslint.config.js, so this tests the real config.
 */
import { ESLint, type Linter } from "eslint";
import reactHooks from "eslint-plugin-react-hooks";
import tseslint from "typescript-eslint";
import { describe, expect, it } from "vitest";
import { AD9_FORBIDDEN_MARKERS } from "@vtc/shared";
import {
  AD9_MARKERS,
  AD9_RESTRICTED_SYNTAX,
  ENGINE_RESTRICTED_SYNTAX,
  REACT_HOOKS_RULES,
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
    'export const k = { ANTHROPIC_API_KEY: "" };'.replace(
      "ANTHROPIC_API_KEY:",
      '"ANTHROPIC_API_KEY":',
    ),
    'export const l = ["env", "CLAUDE_CODE_OAUTH_TOKEN"];',
    "export const m = process.env[`OPENAI_API_KEY`];",
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

describe("AD-1 engine host-neutrality lint rule", () => {
  const rules = { "no-restricted-syntax": ENGINE_RESTRICTED_SYNTAX };
  it.each([
    'export const a = spawn("claude", ["-p"]);',
    'export const b = ["codex", "exec"];',
    "export const c = `claude -p --resume ${id}`;",
    'export const d = "CODEX.exe";',
  ])("flags %s", async (code) => {
    expect(await lint(code, rules)).toEqual([1]);
  });
  it("keeps the AD-9 selectors for engine code", async () => {
    expect(await lint('export const a = ["--yolo"];', rules)).toEqual([1]);
  });
  it("allows hosts by variable and ordinary words", async () => {
    const code = [
      'export const a: string = "claude-code";',
      "export const b = adapters[host];",
      'export const c = "claude says hi";',
    ].join("\n");
    expect(await lint(code, rules)).toEqual([]);
  });
  it("flags the codex host id too: engine code never branches on one host", async () => {
    expect(await lint('export const b = adapters["codex"];', rules)).toEqual([1]);
  });
});

describe("dashboard rules of hooks", () => {
  const lintTsx = async (code: string): Promise<string[]> => {
    const eslint = new ESLint({
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ["**/*.tsx"],
          languageOptions: {
            parser: tseslint.parser,
            parserOptions: { ecmaFeatures: { jsx: true } },
          },
          // The plugin's own type does not fit ESLint's `Plugin` (its legacy `configs`); the
          // rules are all this check needs.
          plugins: { "react-hooks": { rules: reactHooks.rules } },
          rules: REACT_HOOKS_RULES,
        },
      ],
    });
    const [result] = await eslint.lintText(code, { filePath: "planted.tsx" });
    return (result?.messages ?? []).map((m) => m.ruleId ?? "");
  };
  it("flags a conditional hook and a missing effect dependency", async () => {
    const code = [
      'import { useEffect, useState } from "react";',
      "export function Pane({ open, run }: { open: boolean; run: string }) {",
      "  if (open) {",
      "    const [x] = useState(0);",
      "    void x;",
      "  }",
      "  useEffect(() => {",
      "    console.warn(run);",
      "  }, []);",
      "  return <div />;",
      "}",
    ].join("\n");
    expect((await lintTsx(code)).sort()).toEqual([
      "react-hooks/exhaustive-deps",
      "react-hooks/rules-of-hooks",
    ]);
  });
});
