// @ts-check
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * AD-9 markers: permission-bypass flags and host credential locations (spec §12.5, §15).
 * Must equal AD9_FORBIDDEN_MARKERS in packages/shared/src/helpers/compliance.ts
 * (tooling/arch-tests checks this and that every form is caught).
 */
export const AD9_MARKERS = [
  "dangerously-skip-permissions",
  "dangerously-bypass-approvals-and-sandbox",
  "bypassPermissions",
  "--yolo",
  "danger-full-access",
  "dangerously-bypass-hook-trust",
  ".credentials.json",
  "auth.json",
  "find-generic-password",
  "Claude Code-credentials",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
];

const ad9Pattern = AD9_MARKERS.map((m) => m.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")).join("|");
const AD9_MESSAGE = "AD-9: permission bypass flags and host credential locations are forbidden.";

/**
 * `no-restricted-syntax` options for AD-9: any string or template literal containing a marker.
 * @type {import("eslint").Linter.RuleEntry}
 */
export const AD9_RESTRICTED_SYNTAX = [
  "error",
  { selector: `Literal[value=/${ad9Pattern}/i]`, message: AD9_MESSAGE },
  { selector: `TemplateElement[value.raw=/${ad9Pattern}/i]`, message: AD9_MESSAGE },
];

/**
 * AD-1: the engine never runs a host CLI itself. Every host process starts through a
 * `HostAdapter` (injected by the cli), so a literal naming a host binary has no place in engine
 * code. The `codex` host id is the same word, which is intended: engine code refers to hosts only
 * through variables (`HOST_IDS`, an adapter's `host`) and never branches on one host. Includes the AD-9 selectors, because a later `no-restricted-syntax` entry replaces an
 * earlier one for the same files.
 * @type {import("eslint").Linter.RuleEntry}
 */
export const ENGINE_RESTRICTED_SYNTAX = [
  ...AD9_RESTRICTED_SYNTAX,
  {
    selector: "Literal[value=/^(claude|codex)(\\.exe)?$/i]",
    message: "AD-1: the engine starts host processes only through a HostAdapter, never directly.",
  },
  {
    selector: "TemplateElement[value.raw=/^(claude|codex)(\\.exe)?(\\s|$)/i]",
    message: "AD-1: the engine starts host processes only through a HostAdapter, never directly.",
  },
];

/**
 * AD-2 rule 5: packages/shared also runs in the browser, so no Node globals.
 * @type {import("eslint").Linter.RuleEntry}
 */
export const SHARED_RESTRICTED_GLOBALS = [
  "error",
  ...["Buffer", "process", "__dirname", "__filename", "require", "module", "global"].map(
    (name) => ({ name, message: "AD-2: @vtc/shared runs in the browser; no Node globals." }),
  ),
  ...["setImmediate", "clearImmediate"].map((name) => ({
    name,
    message: "AD-2: @vtc/shared runs in the browser; use setTimeout.",
  })),
];

/**
 * React's rules of hooks for the dashboard (apps/*): hooks only at the top level of components
 * and hooks, and complete effect dependencies.
 * @type {import("eslint").Linter.RulesRecord}
 */
export const REACT_HOOKS_RULES = {
  "react-hooks/rules-of-hooks": "error",
  "react-hooks/exhaustive-deps": "error",
};

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "**/.turbo/**",
      "**/node_modules/**",
      ".vtc/**",
      // planted violations used to prove the architecture checks fire
      "tooling/arch-tests/fixtures/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["*.js", "*.cjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", ignoreRestSiblings: true },
      ],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      "no-console": ["error", { allow: ["error", "warn"] }],
    },
  },
  {
    files: ["packages/*/src/**/*.ts", "apps/*/src/**/*.{ts,tsx}"],
    // The deny list itself is the one place the markers may appear.
    ignores: ["**/*.test.{ts,tsx}", "packages/shared/src/helpers/compliance.ts"],
    rules: {
      // AD-9: never bypass host permissions, never touch host credentials (spec §12.5, §15).
      "no-restricted-syntax": AD9_RESTRICTED_SYNTAX,
    },
  },
  {
    files: ["packages/engine/src/**/*.ts"],
    ignores: ["**/*.test.ts"],
    rules: { "no-restricted-syntax": ENGINE_RESTRICTED_SYNTAX },
  },
  {
    files: ["packages/shared/src/**/*.ts"],
    rules: {
      "no-restricted-globals": SHARED_RESTRICTED_GLOBALS,
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "process", message: "AD-2: no Node globals in shared." },
        { object: "globalThis", property: "Buffer", message: "AD-2: no Node globals in shared." },
      ],
    },
  },
  {
    // The Bun driver references its ambient `bun:sqlite` types by path: an import is impossible
    // because the module only exists inside the Bun binary (AD-2 rule 3).
    files: ["packages/engine/src/storage/bun-sqlite.ts"],
    rules: { "@typescript-eslint/triple-slash-reference": ["error", { path: "always" }] },
  },
  {
    files: ["apps/*/src/**/*.tsx", "apps/*/test/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: REACT_HOOKS_RULES,
  },
  {
    files: ["**/*.test.{ts,tsx}", "**/test/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ["**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { ...globals.node } },
  },
);
