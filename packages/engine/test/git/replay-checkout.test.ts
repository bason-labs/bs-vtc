/**
 * Replay checkouts (AD-21 rule 6, spine §5 reading 176): a clean repository at the base with no
 * refs past it, in a work tree outside the user's repo and with its git directory outside the
 * checkout, the trial's work committed there and made readable to the Gate Runner's git in the
 * user's repo; a git directory a role changed runs no engine git.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createGitOps,
  createReplayCheckout,
  exposeReplayHead,
  isReplayTree,
  newReplayTree,
  removeReplayCheckout,
  ReplayCheckoutTamperedError,
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
    const tree = newReplayTree();
    const checkout: ReplayCheckout = { tree, gitDir: join(tempDir(), "trial.git"), base };
    // a fresh private directory under the OS temp directory, outside the user's repo
    expect(relative(repo, tree).startsWith("..")).toBe(true);
    expect(statSync(tree).mode & 0o777).toBe(0o700);
    await createReplayCheckout(repo, checkout);
    expect(readFileSync(join(tree, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(existsSync(join(tree, "src/later.ts"))).toBe(false);
    const inTrial = (...args: string[]) =>
      runGit(tree, [`--git-dir=${checkout.gitDir}`, `--work-tree=${tree}`, ...args], {
        allowFailure: true,
      }).then((r) => ({ code: r.code, out: r.stdout.toString("utf8").trim() }));
    // no ref of the user's repo, and the later commit is not there at all
    expect((await inTrial("for-each-ref")).out).toBe("");
    expect((await inTrial("cat-file", "-e", later)).code).not.toBe(0);
    // the base was fetched by SHA: the user's repo got no ref
    expect(git(repo, "for-each-ref")).toBe(git(repo, "for-each-ref", "refs/heads"));
    // the git directory is not in the checkout: only a pointer file is
    expect(existsSync(join(tree, ".git", "config"))).toBe(false);

    expect(await snapshotReplayCheckout(checkout, "trial")).toBe(base);
    writeFile(tree, "src/a.ts", "export const a = 3;\n");
    const head = await snapshotReplayCheckout(checkout, "trial");
    expect(head).not.toBe(base);
    expect((await inTrial("diff", "--name-only", base, head)).out).toBe("src/a.ts");
    // nothing reached the user's repo
    expect(git(repo, "status", "--porcelain", "--", "src")).toBe("");
    expect((await runGit(repo, ["cat-file", "-e", head], { allowFailure: true })).code).not.toBe(0);

    // for the grade: the head's objects, not a ref, reach the user's repo, where the Gate Runner's
    // GitOps diffs base..head and checks the head out
    const refs = git(repo, "for-each-ref");
    await exposeReplayHead(repo, checkout, head);
    expect(git(repo, "for-each-ref")).toBe(refs);
    const ops = createGitOps({ repoRoot: repo });
    expect(await ops.changedFiles(base, head)).toEqual([{ path: "src/a.ts", status: "modified" }]);
    const clean = await ops.createCleanCheckout(head);
    expect(readFileSync(join(repo, clean, "src/a.ts"), "utf8")).toBe("export const a = 3;\n");
    await ops.removeCheckout(clean);
    expect(git(repo, "status", "--porcelain", "--", "src")).toBe("");

    removeReplayCheckout(checkout);
    expect(existsSync(tree)).toBe(false);
    expect(existsSync(checkout.gitDir)).toBe(false);
    expect(existsSync(`${checkout.gitDir}.fingerprint`)).toBe(false);
  });

  it("runs no engine git on a git directory a role changed (a planted filter driver never runs)", async () => {
    const repo = initRepo({ "README.md": "# app\n", g: "x\n" });
    const base = git(repo, "rev-parse", "HEAD");
    const tree = tempDir();
    const checkout: ReplayCheckout = { tree, gitDir: join(tempDir(), "trial.git"), base };
    await createReplayCheckout(repo, checkout);
    // the role, in its checkout: git finds the private directory through the `.git` file
    expect(readFileSync(join(tree, ".git"), "utf8")).toContain(checkout.gitDir);
    git(tree, "config", "filter.x.clean", "touch PWNED; cat");
    writeFile(tree, ".gitattributes", "g filter=x\n");
    writeFile(tree, "g", "y\n");
    const error = await snapshotReplayCheckout(checkout, "trial").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ReplayCheckoutTamperedError);
    expect((error as ReplayCheckoutTamperedError).paths).toEqual(["config"]);
    expect(existsSync(join(tree, "PWNED"))).toBe(false);
    await expect(exposeReplayHead(repo, checkout, "f".repeat(40))).rejects.toBeInstanceOf(
      ReplayCheckoutTamperedError,
    );
    // a planted hook or attributes file is caught the same way
    git(tree, "config", "--unset", "filter.x.clean");
    writeFile(checkout.gitDir, "info/attributes", "* filter=x\n");
    await expect(snapshotReplayCheckout(checkout, "trial")).rejects.toThrow(/info\/attributes/);
    removeReplayCheckout(checkout);
  });

  it("refuses a base that is not a full sha", async () => {
    const repo = initRepo();
    await expect(
      createReplayCheckout(repo, {
        tree: tempDir(),
        gitDir: join(tempDir(), "x.git"),
        base: "HEAD",
      }),
    ).rejects.toThrow(/full git sha/);
  });

  it("refuses a work tree inside the user's repo, or one that is not empty", async () => {
    const repo = initRepo({ "README.md": "# app\n" });
    const base = git(repo, "rev-parse", "HEAD");
    const inside = join(repo, ".vtc/state/worktrees/R-r1-a-1");
    mkdirSync(inside, { recursive: true });
    await expect(
      createReplayCheckout(repo, { tree: inside, gitDir: join(tempDir(), "x.git"), base }),
    ).rejects.toThrow(/never sits in the user's repo/);
    const used = tempDir();
    writeFile(used, "left.txt", "x\n");
    await expect(
      createReplayCheckout(repo, { tree: used, gitDir: join(tempDir(), "y.git"), base }),
    ).rejects.toThrow(/empty directory of its own/);
  });

  it("fetches only the base commit, and its head still reaches the user's full repo without making it shallow", async () => {
    const repo = initRepo({ "src/a.ts": "export const a = 1;\n" });
    const first = git(repo, "rev-parse", "HEAD");
    writeFile(repo, "src/a.ts", "export const a = 2;\n");
    git(repo, "commit", "-qam", "second");
    const base = git(repo, "rev-parse", "HEAD");
    const checkout: ReplayCheckout = {
      tree: newReplayTree(),
      gitDir: join(tempDir(), "deep.git"),
      base,
    };
    await createReplayCheckout(repo, checkout);
    // the base's parent is not in the trial's git directory
    const parent = await runGit(
      checkout.tree,
      [`--git-dir=${checkout.gitDir}`, "cat-file", "-e", first],
      { allowFailure: true },
    );
    expect(parent.code).not.toBe(0);
    writeFile(checkout.tree, "src/b.ts", "export const b = 1;\n");
    const head = await snapshotReplayCheckout(checkout, "trial");
    await exposeReplayHead(repo, checkout, head);
    expect(existsSync(join(repo, ".git", "shallow"))).toBe(false);
    expect(await createGitOps({ repoRoot: repo }).changedFiles(base, head)).toEqual([
      { path: "src/b.ts", status: "added" },
    ]);
    expect(git(repo, "rev-parse", `${head}^^`)).toBe(first);
    expect(removeReplayCheckout(checkout)).toBe(true);
  });

  it("removes only a work tree it made: a path read back from a file is checked first", () => {
    const tree = tempDir();
    writeFile(tree, "keep.txt", "x\n");
    const gitDir = join(tempDir(), "z.git");
    mkdirSync(gitDir);
    expect(isReplayTree(tree)).toBe(false);
    const made = newReplayTree();
    expect(isReplayTree(made)).toBe(true);
    rmSync(made, { recursive: true });
    expect(removeReplayCheckout({ tree, gitDir, base: "a".repeat(40) })).toBe(false);
    expect(existsSync(join(tree, "keep.txt"))).toBe(true);
    expect(existsSync(gitDir)).toBe(false);
  });
});
