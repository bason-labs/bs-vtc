/** The git module against real temp repositories and a local bare remote (AD-13 rule 4). */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ciFromRollup,
  createGitOps,
  createWorkspace,
  parseNameStatus,
  pullRequestFromGh,
} from "../../src/git/index.js";
import { addBareRemote, cleanupDirs, git, initRepo, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

describe("GitOps (the frozen seam the Gate Runner uses)", () => {
  it("lists changed files with renames, diffs and reads files at a commit", async () => {
    const repo = initRepo({ "src/a.ts": "export const a = 1;\n", "src/b.ts": "b\n" });
    const base = git(repo, "rev-parse", "HEAD");
    git(repo, "mv", "src/b.ts", "src/c.ts");
    writeFile(repo, "src/a.ts", "export const a = 2;\n");
    writeFile(repo, "src/new.ts", "new\n");
    git(repo, "add", "--all");
    git(repo, "commit", "--quiet", "-m", "change");
    const head = git(repo, "rev-parse", "HEAD");
    const ops = createGitOps({ repoRoot: repo });
    const files = await ops.changedFiles(base, head);
    expect(files).toEqual(
      expect.arrayContaining([
        { path: "src/a.ts", status: "modified" },
        { path: "src/new.ts", status: "added" },
        { path: "src/c.ts", status: "renamed", oldPath: "src/b.ts" },
      ]),
    );
    expect(await ops.diff(base, head, ["src/a.ts"])).toContain("+export const a = 2;");
    expect(await ops.diff(base, head, [])).toBe("");
    const bytes = await ops.readFileAtCommit(base, "src/a.ts");
    expect(new TextDecoder().decode(bytes)).toBe("export const a = 1;\n");
    expect(await ops.readFileAtCommit(base, "src/new.ts")).toBeUndefined();
    expect(await ops.readFileAtCommit(base, "src")).toBeUndefined();
  });
  it("makes clean detached checkouts under .vtc/state/checkouts and removes them", async () => {
    const repo = initRepo({ "a.txt": "1\n" });
    const head = git(repo, "rev-parse", "HEAD");
    writeFile(repo, "untracked.txt", "dirty\n");
    const ops = createGitOps({ repoRoot: repo });
    const checkout = await ops.createCleanCheckout(head);
    expect(checkout.startsWith(".vtc/state/checkouts/")).toBe(true);
    expect(readFileSync(join(repo, checkout, "a.txt"), "utf8")).toBe("1\n");
    expect(existsSync(join(repo, checkout, "untracked.txt"))).toBe(false);
    await ops.removeCheckout(checkout);
    expect(existsSync(join(repo, checkout))).toBe(false);
    await ops.removeCheckout(checkout);
    await expect(ops.removeCheckout("src/elsewhere")).rejects.toThrow(TypeError);
  });
  it("rejects abbreviated shas", async () => {
    const ops = createGitOps({ repoRoot: initRepo() });
    await expect(ops.changedFiles("abc", "def")).rejects.toThrow(TypeError);
  });
  it("parses name-status output", () => {
    expect(parseNameStatus("M\0a\0R100\0b\0c\0D\0d\0")).toEqual([
      { path: "a", status: "modified" },
      { path: "c", status: "renamed", oldPath: "b" },
      { path: "d", status: "deleted" },
    ]);
  });
});

describe("workspace: worktrees, snapshots, merges and pushes", () => {
  it("snapshots a task worktree onto vtc/T-n without touching the user's checkout", async () => {
    const repo = initRepo({ "src/a.ts": "a\n" });
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    const integration = await ws.ensureIntegration("F-1", "vtc/F-1", base);
    expect(integration).toEqual({ worktree: ".vtc/state/worktrees/F-1", head: base });
    const task = await ws.ensureTaskWorktree("T-1", "vtc/T-1", integration.head);
    writeFile(join(repo, task.worktree), "src/b.ts", "b\n");
    const head = await ws.snapshot(task.worktree, "T-1 round 1");
    expect(head).not.toBe(base);
    expect(await ws.snapshot(task.worktree, "nothing new")).toBe(head);
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(head);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(await ws.treeOf(head)).toMatch(/^[a-f0-9]{40}$/);
    expect(await ws.isAncestor(base, head)).toBe(true);
    const merged = await ws.merge(integration.worktree, "vtc/T-1", "Merge T-1");
    expect(merged.ok).toBe(true);
    if (merged.ok) expect(await ws.isAncestor(head, merged.commit)).toBe(true);
  });
  it("reports a rebase conflict and leaves the worktree clean", async () => {
    const repo = initRepo({ "src/a.ts": "a\n" });
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    const f = await ws.ensureIntegration("F-1", "vtc/F-1", base);
    const t1 = await ws.ensureTaskWorktree("T-1", "vtc/T-1", base);
    const t2 = await ws.ensureTaskWorktree("T-2", "vtc/T-2", base);
    writeFile(join(repo, t1.worktree), "src/a.ts", "one\n");
    writeFile(join(repo, t2.worktree), "src/a.ts", "two\n");
    await ws.snapshot(t1.worktree, "t1");
    await ws.snapshot(t2.worktree, "t2");
    const m1 = await ws.merge(f.worktree, "vtc/T-1", "Merge T-1");
    expect(m1.ok).toBe(true);
    const rebased = await ws.rebase(t2.worktree, "vtc/F-1");
    expect(rebased).toMatchObject({ ok: false, conflict: true });
    expect(git(join(repo, t2.worktree), "status", "--porcelain")).toBe("");
    const conflictMerge = await ws.merge(f.worktree, "vtc/T-2", "Merge T-2");
    expect(conflictMerge).toMatchObject({ ok: false, conflict: true });
    expect(git(join(repo, f.worktree), "status", "--porcelain")).toBe("");
  });
  it("pushes the integration branch to a local bare remote, never force", async () => {
    const repo = initRepo();
    const bare = addBareRemote(repo);
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    await ws.ensureIntegration("F-1", "vtc/F-1", base);
    expect(await ws.remoteUrl("origin")).toBe(bare);
    expect(await ws.remoteUrl("nope")).toBeNull();
    const pushed = await ws.push("origin", "vtc/F-1");
    expect(pushed.ok).toBe(true);
    expect(git(bare, "rev-parse", "vtc/F-1")).toBe(base);
    expect((await ws.push("nope", "vtc/F-1")).ok).toBe(false);
  });
});

describe("pull requests via gh (parsing only; no network in tests)", () => {
  it("maps gh JSON to a PullRequestRef", () => {
    const sha = "a".repeat(40);
    expect(pullRequestFromGh({ url: "https://github.com/o/r/pull/1", isDraft: true, state: "OPEN", headRefOid: sha, statusCheckRollup: [] })).toEqual({
      url: "https://github.com/o/r/pull/1",
      draft: true,
      state: "open",
      head_sha: sha,
      ci: "unknown",
    });
    expect(pullRequestFromGh({ url: "https://x/1", state: "MERGED", headRefOid: sha, mergeCommit: { oid: "b".repeat(40) } })).toMatchObject({ state: "merged", merge_commit: "b".repeat(40) });
    expect(pullRequestFromGh({})).toBeNull();
  });
  it("reads CI from the status rollup", () => {
    expect(ciFromRollup([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }])).toBe("green");
    expect(ciFromRollup([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
    expect(ciFromRollup([{ conclusion: "FAILURE" }])).toBe("red");
    expect(ciFromRollup(undefined)).toBe("unknown");
  });
});
