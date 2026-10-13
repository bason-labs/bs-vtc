// @ts-check
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/**", "**/coverage/**", "**/.turbo/**", "**/node_modules/**", ".vtc/**"],
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
    ignores: ["**/*.test.ts"],
    rules: {
      // AD-9: never bypass host permissions, never touch host credentials (spec §12.5, §15).
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "Literal[value=/dangerously-skip-permissions|bypassPermissions|auth\\.json|\\.claude\\/\\.credentials/]",
          message: "AD-9: permission bypass flags and host credential paths are forbidden.",
        },
        {
          selector:
            "TemplateElement[value.raw=/dangerously-skip-permissions|bypassPermissions|auth\\.json|\\.claude\\/\\.credentials/]",
          message: "AD-9: permission bypass flags and host credential paths are forbidden.",
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/test/**/*.ts"],
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
