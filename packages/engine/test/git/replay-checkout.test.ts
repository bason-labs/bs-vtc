/**
 * Replay checkouts (AD-21 rule 6, spine §5 reading 176): a clean repository at the base with no
 * refs past it, its git directory outside the checkout, the trial's work committed there.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createReplayCheckout,
  removeReplayCheckout,
  runGit,
  snapshotReplayCheckout,
  type ReplayCheckout,
} from "../../src/git/index.js";
import { cleanupDirs, git, initRepo, tempDir, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

describe("replay checkouts (reading 176)", () => {
  it("holds the base and nothing after it, and commits the trial's work there", async () => {
    const repo = initRepo({ "README.md": "# app\n", "src/a.ts": "export const a = 1;\n" });
    const base = git(repo, "rev-parse", "HEAD");
    writeFile(repo, "src/later.ts", "export const later = 2;\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-qm", "later work");
    const later = git(repo, "rev-parse", "HEAD");
    const checkout: ReplayCheckout = {
      path: ".vtc/state/worktrees/R-r1-a-9",
      gitDir: join(tempDir(), "trial.git"),
      base,
    };
    await createReplayCheckout(repo, checkout);
    const tree = join(repo, checkout.path);
    expect(readFileSync(join(tree, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(tree, "src/later.ts"))).toBe(false);
    const inTrial = (...args: string[]) =>
      runGit(tree, [`--git-dir=${checkout.gitDir}`, `--work-tree=${tree}`, ...args], {
        allowFailure: true,
      }).then((r) => ({ code: r.code, out: r.stdout.toString("utf8").trim() }));
    // no ref of the user's repo, and the later commit is not there at all
    expect((await inTrial("for-each-ref")).out).toBe("");
    expect((await inTrial("cat-file", "-e", later)).code).not.toBe(0);
    // the temporary ref used to fetch the base is gone from the user's repo
    expect(git(repo, "for-each-ref", "refs/vtc")).toBe("");
    // the git directory is not in the checkout: only a pointer file is
    expect(existsSync(join(tree, ".git", "config"))).toBe(false);

    expect(await snapshotReplayCheckout(repo, checkout, "trial")).toBe(base);
    writeFile(tree, "src/a.ts", "export const a = 3;\n");
    const head = await snapshotReplayCheckout(repo, checkout, "trial");
    expect(head).not.toBe(base);
    expect((await inTrial("diff", "--name-only", base, head)).out).toBe("src/a.ts");
    // nothing reached the user's repo
    expect(git(repo, "status", "--porcelain", "--", "src")).toBe("");
    expect((await runGit(repo, ["cat-file", "-e", head], { allowFailure: true })).code).not.toBe(0);

    removeReplayCheckout(repo, checkout);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(checkout.gitDir)).toBe(false);
  });

  it("refuses a base that is not a full sha", async () => {
    const repo = initRepo();
    await expect(
      createReplayCheckout(repo, {
        path: ".vtc/state/worktrees/R-r1-a-1",
        gitDir: join(tempDir(), "x.git"),
        base: "HEAD",
      }),
    ).rejects.toThrow(/full git sha/);
  });
});
