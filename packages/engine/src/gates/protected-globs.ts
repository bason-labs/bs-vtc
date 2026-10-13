/**
 * Configuration files a diff could use to weaken the gates (§7.2 L1/L4/L5, §7.3, §7.6 rule 5).
 * `vtc calibrate` always writes all of them to `tests.protected_configs`, whether or not a match
 * exists yet; L5 flags every changed file that matches; L1 and the scanners run with the base
 * commit's version of any that the diff changed. Pure data. `pyproject.toml` and `package.json`
 * also hold dependencies, so only their tool sections are guarded (`mixed-configs.ts`).
 */

/** Lint, type-check and test configuration. */
export const LINT_TEST_CONFIG_GLOBS: readonly string[] = [
  "**/eslint.config.*",
  "**/.eslintrc*",
  "**/biome.json",
  "**/biome.jsonc",
  "**/vitest.config.*",
  "**/vitest.workspace.*",
  // Vitest reads `test.include`/`exclude` from the Vite config when there is no vitest.config.
  "**/vite.config.*",
  "**/jest.config.*",
  "**/.mocharc*",
  "**/.nycrc*",
  "**/.c8rc*",
  "**/playwright.config.*",
  "**/tsconfig*.json",
  "**/pytest.ini",
  "**/conftest.py",
  "**/tox.ini",
  "**/setup.cfg",
  "**/.flake8",
  "**/ruff.toml",
  "**/.ruff.toml",
  "**/mypy.ini",
  "**/.mypy.ini",
  "**/pyrightconfig.json",
  "**/.pylintrc",
  "**/pylintrc",
  "**/.coveragerc",
  "**/.golangci.y*ml",
  "**/.dependency-cruiser.*",
];

/**
 * Scanner configuration and ignore files the pinned scanners read from the scanned tree on their
 * own: Gitleaks (`.gitleaks.toml`, `.gitleaksignore`), osv-scanner (`osv-scanner.toml` next to
 * each lockfile), Opengrep (`.semgrepignore`, repo rules) and Checkov (`.checkov.yaml`, whose
 * `external-checks-dir` runs Python). Adding or changing one is a new suppression.
 */
export const SCANNER_CONFIG_GLOBS: readonly string[] = [
  "**/.gitleaks.toml",
  "**/.gitleaksignore",
  "**/osv-scanner.toml",
  "**/.osv-scanner.toml",
  "**/.semgrepignore",
  "**/.opengrepignore",
  "**/.semgrep.yml",
  "**/.semgrep.yaml",
  "**/.semgrep/**",
  "**/.checkov.yaml",
  "**/.checkov.yml",
];

/** Everything L5 protects by default, on top of the project's `tests.protected_configs`. */
export const DEFAULT_PROTECTED_GLOBS: readonly string[] = [
  ...LINT_TEST_CONFIG_GLOBS,
  ...SCANNER_CONFIG_GLOBS,
];
