/** L5 write-scope and test-integrity check (§6.3 step 4, §7.2 L5, §7.3) against real commits. */
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WriteScopeReportSchema } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { createGitOps } from "../../src/git/index.js";
import { addedLinesByFile, checkWriteScope, scanAddedLines } from "../../src/gates/index.js";
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
