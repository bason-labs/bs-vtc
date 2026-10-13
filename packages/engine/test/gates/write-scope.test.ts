/** L5 write-scope and test-integrity check (§6.3 step 4, §7.2 L5, §7.3) against real commits. */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WriteScopeReportSchema } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createGitOps } from "../../src/git/index.js";
import {
  addedLinesByFile,
  checkWriteScope,
  guardedSections,
  scanAddedLines,
  withBaseSections,
} from "../../src/gates/index.js";
import { cleanupDirs, git, initRepo, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const commitAll = (repo: string, message: string): string => {
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

const QA_TEST = "it('[REQ-1] works', () => { expect(f()).toBe(1); });\n";

const setup = (): { repo: string; base: string } => {
  const repo = initRepo({
    "src/app.ts": "export const f = () => 1;\n",
    "src/other.ts": "export const g = 2;\n",
    "tests/acceptance/f.test.ts": QA_TEST,
    "vitest.config.ts": "export default {};\n",
    "src/__snapshots__/app.test.ts.snap": "exports[`a`] = `1`;\n",
  });
  return { repo, base: git(repo, "rev-parse", "HEAD") };
};

const request = (base: string, head: string) => ({
  worktree: ".vtc/state/worktrees/T-1",
  base,
  head,
  filesScope: ["src/app.ts", "src/__snapshots__/**", "src/new/**"],
  protected: [
    { path: "tests/acceptance/f.test.ts", sha256: sha(QA_TEST) },
    { path: "vitest.config.ts", sha256: sha("export default {};\n") },
  ],
});

describe("checkWriteScope", () => {
  it("passes an in-scope change", async () => {
    const { repo, base } = setup();
    writeFile(repo, "src/app.ts", "export const f = () => 1 + 0;\n");
    writeFile(repo, "src/new/x.ts", "export const x = 1;\n");
    const head = commitAll(repo, "work");
    const report = await checkWriteScope(createGitOps({ repoRoot: repo }), request(base, head));
    expect(report).toEqual({ ok: true, violations: [] });
  });

  it("reports out-of-scope writes, protected edits and deletions, skips, suppressions and snapshot rewrites", async () => {
    const { repo, base } = setup();
    writeFile(repo, "src/other.ts", "export const g = 3;\n");
    writeFile(repo, "tests/acceptance/f.test.ts", "it.skip('[REQ-1] works', () => {});\n");
    rmSync(join(repo, "vitest.config.ts"));
    writeFile(
      repo,
      "src/app.ts",
      "// eslint-disable-next-line\nexport const f = () => 1;\ndescribe.only('x', () => {});\n",
    );
    writeFile(repo, "src/__snapshots__/app.test.ts.snap", "exports[`a`] = `2`;\n");
    const head = commitAll(repo, "gaming");
    const report = await checkWriteScope(createGitOps({ repoRoot: repo }), request(base, head));
    WriteScopeReportSchema.parse(report);
    expect(report.ok).toBe(false);
    expect(report.violations).toEqual([
      { kind: "snapshot_rewrite", path: "src/__snapshots__/app.test.ts.snap" },
      { kind: "new_skip", path: "src/app.ts" },
      { kind: "new_suppression", path: "src/app.ts" },
      { kind: "out_of_scope_write", path: "src/other.ts" },
      { kind: "new_skip", path: "tests/acceptance/f.test.ts" },
      { kind: "protected_modified", path: "tests/acceptance/f.test.ts" },
      { kind: "protected_deleted", path: "vitest.config.ts" },
    ]);
  });

  it("counts both sides of a rename and ignores markers mentioned in prose", async () => {
    const { repo, base } = setup();
    writeFile(repo, "src/new/README.md", "Never add `eslint-disable` or `it.only`.\n");
    git(repo, "mv", "src/other.ts", "src/new/other.ts");
    const head = commitAll(repo, "move");
    const report = await checkWriteScope(createGitOps({ repoRoot: repo }), request(base, head));
    expect(report.violations).toEqual([{ kind: "out_of_scope_write", path: "src/other.ts" }]);
  });
});

describe("config files a diff adds (§7.3, §7.6 rule 5)", () => {
  it("flags new in-scope test, lint and scanner configs unless the scope names them exactly", async () => {
    const { repo, base } = setup();
    writeFile(repo, "src/new/vitest.config.ts", "export default { test: { include: [] } };\n");
    writeFile(repo, "src/new/.eslintrc.json", '{ "rules": {} }\n');
    writeFile(repo, "src/new/osv-scanner.toml", "[[IgnoredVulns]]\nid = 'GHSA-x'\n");
    writeFile(repo, "src/new/conftest.py", "collect_ignore = ['test_a.py']\n");
    const head = commitAll(repo, "configs");
    const git = createGitOps({ repoRoot: repo });
    const report = await checkWriteScope(git, request(base, head));
    expect(report.violations).toEqual([
      { kind: "protected_modified", path: "src/new/.eslintrc.json" },
      { kind: "protected_modified", path: "src/new/conftest.py" },
      { kind: "new_suppression", path: "src/new/osv-scanner.toml" },
      { kind: "protected_modified", path: "src/new/vitest.config.ts" },
    ]);
    const planned = {
      ...request(base, head),
      filesScope: [...request(base, head).filesScope, "src/new/conftest.py"],
    };
    expect((await checkWriteScope(git, planned)).violations.map((v) => v.path)).not.toContain(
      "src/new/conftest.py",
    );
    // A project's own protected globs apply too.
    const custom = await checkWriteScope(git, request(base, head), ["**/conftest.py"]);
    expect(custom.violations).toEqual([
      { kind: "protected_modified", path: "src/new/conftest.py" },
    ]);
  });
});

describe("protected configs in any letter case (case-insensitive file systems)", () => {
  it("flags a config whose name differs from the canonical one only in case", async () => {
    // On macOS APFS, Vitest's existsSync("vitest.config.ts") finds Vitest.config.ts and loads it.
    const repo = initRepo({ "src/app.ts": "export const f = () => 1;\n" });
    const base = git(repo, "rev-parse", "HEAD");
    writeFile(repo, "packages/x/Vitest.config.ts", "export default { test: { include: [] } };\n");
    writeFile(repo, "packages/x/TSConfig.json", "{}\n");
    writeFile(repo, "py/Conftest.py", "collect_ignore = ['test_a.py']\n");
    writeFile(repo, ".GitleaksIgnore", "src/app.ts\n");
    writeFile(repo, "PyProject.toml", "[tool.ruff.lint]\nignore = ['ALL']\n");
    writeFile(repo, "src/app.ts", "export const f = () => 2;\n");
    const head = commitAll(repo, "case games");
    const ops = createGitOps({ repoRoot: repo });
    const scope = { ...request(base, head), protected: [], filesScope: ["**"] };
    expect((await checkWriteScope(ops, scope)).violations).toEqual([
      { kind: "new_suppression", path: ".GitleaksIgnore" },
      { kind: "protected_modified", path: "PyProject.toml" },
      { kind: "protected_modified", path: "packages/x/TSConfig.json" },
      { kind: "protected_modified", path: "packages/x/Vitest.config.ts" },
      { kind: "protected_modified", path: "py/Conftest.py" },
    ]);
    // A project's own protected globs match in any case too.
    const custom = await checkWriteScope(ops, scope, ["**/conftest.py"]);
    expect(custom.violations.map((v) => v.path)).toContain("py/Conftest.py");
    // Only the exact path named in files_scope allows the change.
    const planned = { ...scope, filesScope: ["**", "packages/x/Vitest.config.ts"] };
    const left = (await checkWriteScope(ops, planned)).violations.map((v) => v.path);
    expect(left).not.toContain("packages/x/Vitest.config.ts");
    expect(left).toContain("packages/x/TSConfig.json");
  });
});

describe("standalone tox and hatch configs", () => {
  it("flags a changed tox.toml or hatch.toml under a ** files_scope", async () => {
    const repo = initRepo({
      "tox.toml": '[env.test]\ncommands = [["pytest"]]\n',
      "sub/hatch.toml": '[envs.default.scripts]\ntest = "pytest"\n',
      "src/app.py": "x = 1\n",
    });
    const base = git(repo, "rev-parse", "HEAD");
    writeFile(repo, "tox.toml", '[env.test]\ncommands = [["true"]]\n');
    writeFile(repo, "sub/hatch.toml", '[envs.default.scripts]\ntest = "true"\n');
    writeFile(repo, "src/app.py", "x = 2\n");
    const head = commitAll(repo, "weaken tox and hatch");
    const ops = createGitOps({ repoRoot: repo });
    const scope = { ...request(base, head), protected: [], filesScope: ["**"] };
    expect((await checkWriteScope(ops, scope)).violations).toEqual([
      { kind: "protected_modified", path: "sub/hatch.toml" },
      { kind: "protected_modified", path: "tox.toml" },
    ]);
  });
});

describe("tool sections of pyproject.toml and package.json (§7.2 L1/L5)", () => {
  const PY = [
    "[project]",
    'name = "app"',
    'dependencies = ["requests"]',
    "",
    "[tool.ruff.lint]",
    'select = ["E"]',
    "",
    "[tool.poetry]",
    'packages = [{ include = "app" }]',
    "",
  ].join("\n");

  it("guards lint and test tool tables, never dependencies", () => {
    const sections = guardedSections("pyproject.toml", PY);
    const deps = PY.replace('["requests"]', '["requests", "httpx"]');
    expect(guardedSections("pyproject.toml", deps)).toBe(sections);
    expect(
      guardedSections("pyproject.toml", PY.replace("[tool.poetry]\n", "[tool.poetry]\nx = 1\n")),
    ).toBe(sections);
    expect(guardedSections("pyproject.toml", `${PY}# a comment\n\n`)).toBe(sections);
    const changed = [
      PY.replace('select = ["E"]', 'select = ["E"]\nignore = ["ALL"]'),
      `${PY}[tool.pytest.ini_options]\naddopts = "--deselect tests/test_a.py"\n`,
      `${PY}[ tool . "mypy" ]\nignore_errors = true\n`,
      `${PY}[[tool.mypy.overrides]]\nmodule = "*"\nignore_errors = true\n`,
      `tool.coverage.run.omit = ["*"]\n${PY}`,
      `${PY}[tool]\nruff.lint.ignore = ["ALL"]\n`,
      // A header-like line inside a multi-line array does not end the guarded table.
      PY.replace('select = ["E"]', 'select = ["E"]\nx = [\n["a"]\n]\nignore = ["ALL"]'),
    ];
    for (const text of changed) expect(guardedSections("pyproject.toml", text)).not.toBe(sections);
    expect(guardedSections("pyproject.toml", undefined)).toBe("");
  });

  it("decodes quoted and escaped table headers the way TOML does (finding: quoted header bypass)", () => {
    const sections = guardedSections("pyproject.toml", PY);
    // Each weakened tool table comes after an unguarded table, where a header the splitter did
    // not recognise would be swallowed into [project.urls].
    const after = (header: string, body: string): string =>
      `${PY}[project.urls]\nhome = "h"\n${header}\n${body}\n`;
    for (const header of [
      '[tool."ruff".lint]',
      "[tool.'ruff'.lint]",
      '[tool."\\u0072uff".lint]',
      '[tool."\\U00000072uff".lint]',
      '[ "tool" . "ruff" . "lint" ]  # comment',
      '[[tool."mypy".overrides]]',
      '[tool."pytest".ini_options]',
    ]) {
      const text = after(header, 'ignore = ["ALL"]');
      expect(guardedSections("pyproject.toml", text), header).not.toBe(sections);
      // L1 runs with the base tool sections: the weakened table is gone.
      expect(withBaseSections("pyproject.toml", text, PY), header).not.toContain("ALL");
    }
    // A quoted key that names an unguarded table is still unguarded.
    expect(guardedSections("pyproject.toml", after('[tool."poetry".extras]', "x = 1"))).toBe(
      sections,
    );
    // A quoted key holding a dot or a bracket is one key: tool."ruff.lint" is not tool.ruff.lint.
    expect(guardedSections("pyproject.toml", after('[tool."ruff.lint"]', "x = 1"))).toBe(sections);
    expect(guardedSections("pyproject.toml", after('[tool."r]uff".lint]', "x = 1"))).toBe(sections);
  });

  it("fails closed on a table header it cannot decode", () => {
    const sections = guardedSections("pyproject.toml", PY);
    for (const header of [
      '[tool.ruff.lint] ignore = ["ALL"]',
      '[tool."ruff"x]',
      '[tool."\\q".lint]',
      '[tool."ruff]',
      "[tool..ruff]",
      "[tool.ruff",
      "[]",
    ]) {
      const text = `${PY}[project.urls]\nhome = "h"\n${header}\nignore = ["ALL"]\n`;
      expect(guardedSections("pyproject.toml", text), header).not.toBe(sections);
      // An undecodable head file runs L1 with the base file whole.
      expect(withBaseSections("pyproject.toml", text, PY), header).toBe(PY);
    }
    const weird = `${PY}[tool.ruff] x = 1\n`;
    // With an undecodable header, any change of the file counts, a dependency change included.
    expect(guardedSections("pyproject.toml", weird.replace('["requests"]', '["httpx"]'))).not.toBe(
      guardedSections("pyproject.toml", weird),
    );
  });

  it("guards the pyproject task runners a gate command can call (tox, hatch, pdm, poe)", () => {
    const sections = guardedSections("pyproject.toml", PY);
    for (const added of [
      '[tool.tox]\nlegacy_tox_ini = """\n[testenv]\ncommands = true\n"""',
      '[tool.hatch.envs.default.scripts]\ntest = "true"',
      '[tool.hatch.envs.default]\nscripts = { test = "true" }',
      '[tool.hatch]\nenvs.default.scripts.test = "true"',
      '[tool.pdm.scripts]\ntest = "true"',
      '[tool.pdm]\nscripts.test = "true"',
      '[tool.poe.tasks]\ntest = "true"',
    ]) {
      expect(guardedSections("pyproject.toml", `${PY}${added}\n`), added).not.toBe(sections);
    }
    // Build configuration of the same tools is not a gate command.
    expect(guardedSections("pyproject.toml", `${PY}[tool.hatch.build]\nexclude = ["x"]\n`)).toBe(
      sections,
    );
  });

  it("guards package.json scripts and test-tool keys, never dependencies", () => {
    const pkg = { name: "a", dependencies: { x: "1" }, scripts: { test: "vitest run" } };
    const sections = guardedSections("package.json", JSON.stringify(pkg));
    const deps = { ...pkg, dependencies: { x: "2", y: "1" } };
    expect(guardedSections("package.json", JSON.stringify(deps, null, 2))).toBe(sections);
    for (const changed of [
      { ...pkg, scripts: { test: "true" } },
      { ...pkg, jest: { testPathIgnorePatterns: ["."] } },
      { ...pkg, eslintConfig: { rules: {} } },
    ]) {
      expect(guardedSections("package.json", JSON.stringify(changed))).not.toBe(sections);
    }
    expect(guardedSections("package.json", "{ not json")).not.toBe(sections);
  });

  it("merges the base tool sections into the head file", () => {
    const head = PY.replace('["requests"]', '["httpx"]').replace(
      'select = ["E"]',
      'select = ["E"]\nignore = ["ALL"]',
    );
    const merged = withBaseSections("pyproject.toml", head, PY);
    expect(merged).toContain('dependencies = ["httpx"]');
    expect(merged).toContain("[tool.poetry]");
    expect(merged).not.toContain("ALL");
    expect(guardedSections("pyproject.toml", merged)).toBe(guardedSections("pyproject.toml", PY));
    expect(withBaseSections("pyproject.toml", head, undefined)).not.toContain("tool.ruff");

    const basePkg = JSON.stringify({ name: "a", scripts: { lint: "eslint ." } });
    const headPkg = JSON.stringify({
      name: "a",
      version: "2",
      scripts: { lint: "true" },
      jest: {},
    });
    expect(JSON.parse(withBaseSections("package.json", headPkg, basePkg))).toEqual({
      name: "a",
      version: "2",
      scripts: { lint: "eslint ." },
    });
  });

  it("flags a changed tool section in L5 unless the scope names the file exactly", async () => {
    const repo = initRepo({
      "pyproject.toml": PY,
      "web/package.json": JSON.stringify({ name: "w", scripts: { test: "vitest run" } }),
      "src/app.ts": "export const f = () => 1;\n",
    });
    const base = git(repo, "rev-parse", "HEAD");
    const scope = { ...request(base, base), protected: [], filesScope: ["**"] };
    const ops = createGitOps({ repoRoot: repo });

    writeFile(repo, "pyproject.toml", PY.replace('["requests"]', '["httpx"]'));
    writeFile(
      repo,
      "web/package.json",
      JSON.stringify({ name: "w", version: "2", scripts: { test: "vitest run" } }),
    );
    const deps = commitAll(repo, "deps");
    expect(await checkWriteScope(ops, { ...scope, head: deps })).toEqual({
      ok: true,
      violations: [],
    });

    writeFile(
      repo,
      "pyproject.toml",
      PY.replace('select = ["E"]', 'select = ["E"]\nignore = ["ALL"]'),
    );
    writeFile(repo, "web/package.json", JSON.stringify({ name: "w", scripts: { test: "true" } }));
    writeFile(repo, "web/vite.config.ts", "export default { test: { exclude: ['**'] } };\n");
    writeFile(repo, "setup.cfg", "[flake8]\nextend-ignore = E\n");
    const head = commitAll(repo, "weaken");
    expect((await checkWriteScope(ops, { ...scope, head })).violations).toEqual([
      { kind: "protected_modified", path: "pyproject.toml" },
      { kind: "protected_modified", path: "setup.cfg" },
      { kind: "protected_modified", path: "web/package.json" },
      { kind: "protected_modified", path: "web/vite.config.ts" },
    ]);
    const planned = { ...scope, head, filesScope: ["**", "pyproject.toml"] };
    expect((await checkWriteScope(ops, planned)).violations.map((v) => v.path)).not.toContain(
      "pyproject.toml",
    );

    rmSync(join(repo, "pyproject.toml"));
    const gone = commitAll(repo, "delete");
    expect((await checkWriteScope(ops, { ...scope, base: head, head: gone })).violations).toEqual([
      { kind: "protected_deleted", path: "pyproject.toml" },
    ]);
  });
});

describe("task-runner files a gate command calls (D-y, spine §5 reading 45)", () => {
  const RUNNERS: Record<string, string> = {
    Makefile: "test:\n\tpytest\n",
    "sub/GNUmakefile": "test:\n\tpytest\n",
    "sub/makefile": "test:\n\tpytest\n",
    "mk/test.mk": "test:\n\tpytest\n",
    justfile: "test:\n  pytest\n",
    "a/Justfile": "test:\n  pytest\n",
    "b/.justfile": "test:\n  pytest\n",
    "c/JUSTFILE": "test:\n  pytest\n",
    "d/tasks.just": "test:\n  pytest\n",
    "Taskfile.yml": "tasks:\n  test:\n    cmds: [pytest]\n",
    "e/taskfile.dist.yaml": "tasks:\n  test:\n    cmds: [pytest]\n",
    "noxfile.py": "def tests(session):\n    session.run('pytest')\n",
  };

  it("flags any change under a ** files_scope unless the scope names the file exactly", async () => {
    const repo = initRepo({ ...RUNNERS, "src/app.py": "x = 1\n" });
    const base = git(repo, "rev-parse", "HEAD");
    const ops = createGitOps({ repoRoot: repo });
    const scope = { ...request(base, base), protected: [], filesScope: ["**"] };
    // A `make test` recipe rewritten so the L2 gate passes on exit code alone.
    for (const path of Object.keys(RUNNERS)) writeFile(repo, path, "test:\n\t@true\n");
    writeFile(repo, "src/app.py", "x = 2\n");
    const head = commitAll(repo, "weaken the test recipes");
    const report = await checkWriteScope(ops, { ...scope, head });
    expect(report.violations).toEqual(
      Object.keys(RUNNERS)
        .sort()
        .map((path) => ({ kind: "protected_modified", path })),
    );
    // A project's own globs replace the defaults, but task-runner files stay guarded.
    expect(
      (await checkWriteScope(ops, { ...scope, head }, ["**/conftest.py"])).violations,
    ).toHaveLength(Object.keys(RUNNERS).length);
    const planned = { ...scope, head, filesScope: ["**", "Makefile", "mk/test.mk"] };
    const left = (await checkWriteScope(ops, planned)).violations.map((v) => v.path);
    expect(left).not.toContain("Makefile");
    expect(left).not.toContain("mk/test.mk");
    expect(left).toContain("justfile");
  });
});

describe("added-line scanning", () => {
  it("finds markers of every supported ecosystem on added lines only", () => {
    const diff = [
      "diff --git a/t.py b/t.py",
      "--- a/t.py",
      "+++ b/t.py",
      "@@ -1 +1,3 @@",
      "-@pytest.mark.skip",
      "+@pytest.mark.xfail(reason='x')",
      "+x = 1  # noqa: E501",
      "diff --git a/a_test.go b/a_test.go",
      "+++ b/a_test.go",
      '+\tt.Skip("later")',
      "diff --git a/gone.ts b/gone.ts",
      "+++ /dev/null",
      "-it.skip('x')",
      "diff --git a/ok.ts b/ok.ts",
      "+++ b/ok.ts",
      "+const skip = items.skip(1); // fine: not a test API",
    ].join("\n");
    expect(addedLinesByFile(diff).get("t.py")).toHaveLength(2);
    expect(scanAddedLines(diff)).toEqual([
      ["new_skip", "t.py"],
      ["new_suppression", "t.py"],
      ["new_skip", "a_test.go"],
    ]);
  });
});
