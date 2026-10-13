/** The git module against real temp repositories and a local bare remote (AD-13 rule 4). */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ciFromRollup,
  createGitOps,
  createWorkspace,
  createGhPullRequests,
  parseNameStatus,
  pullRequestFromGh,
  WorktreeError,
  appendRepoFile,
  UnsafePathError,
  writeRepoFile,
} from "../../src/git/index.js";
import { addBareRemote, cleanupDirs, git, initRepo, tempDir, writeFile } from "../helpers/repo.js";

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

describe("worktree commands are pinned to the repo (agents own the worktree's .git file)", () => {
  /** A repo whose user has uncommitted and untracked work, and a task worktree with a change. */
  const setup = async () => {
    const repo = initRepo({ "a.txt": "1\n" });
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    const task = await ws.ensureTaskWorktree("T-1", "vtc/T-1", base);
    writeFile(repo, "a.txt", "user edit\n");
    writeFile(repo, "untracked-user.txt", "keep me\n");
    writeFile(join(repo, task.worktree), "src/t.ts", "agent\n");
    return { repo, ws, base, worktree: task.worktree };
  };
  const userCheckoutIntact = (repo: string, base: string): void => {
    expect(git(repo, "rev-parse", "main")).toBe(base);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(repo, "a.txt"), "utf8")).toBe("user edit\n");
    expect(readFileSync(join(repo, "untracked-user.txt"), "utf8")).toBe("keep me\n");
  };

  it("snapshot and discard with the .git file deleted never touch the user's checkout", async () => {
    const { repo, ws, base, worktree } = await setup();
    rmSync(join(repo, worktree, ".git"));
    const head = await ws.snapshot(worktree, "vtc: T-1 round 1");
    userCheckoutIntact(repo, base);
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(head);
    expect(git(repo, "show", "--name-only", "--format=", head)).toBe("src/t.ts");
    // the .git file is repaired, so the worktree is a worktree again
    expect(readFileSync(join(repo, worktree, ".git"), "utf8")).toMatch(/^gitdir: /);
    writeFile(join(repo, worktree), "stray.txt", "x\n");
    rmSync(join(repo, worktree, ".git"));
    await ws.discard(worktree, base);
    userCheckoutIntact(repo, base);
    expect(existsSync(join(repo, worktree, "stray.txt"))).toBe(false);
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(base);
  });
  it("a .git file rewritten to another repository is ignored and repaired", async () => {
    const { repo, ws, base, worktree } = await setup();
    // pointing the worktree at the user's own .git would make `git commit` commit onto main
    writeFileSync(join(repo, worktree, ".git"), `gitdir: ${join(repo, ".git")}\n`);
    const head = await ws.snapshot(worktree, "vtc: T-1 round 1");
    userCheckoutIntact(repo, base);
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(head);
    expect(await ws.isDirty(worktree)).toBe(false);
    // an attacker repository: its config would run code through core.fsmonitor or hooks
    const evil = tempDir("vtc-evil-");
    git(evil, "init", "--quiet");
    const marker = join(evil, "pwned");
    git(evil, "config", "core.fsmonitor", `touch ${marker}`);
    writeFileSync(join(repo, worktree, ".git"), `gitdir: ${join(evil, ".git")}\n`);
    writeFile(join(repo, worktree), "src/u.ts", "more\n");
    const next = await ws.snapshot(worktree, "vtc: T-1 round 2");
    expect(existsSync(marker)).toBe(false);
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(next);
    userCheckoutIntact(repo, base);
  });
  it("runs no hook of the repo on engine commits and keeps HEAD on the task branch", async () => {
    const { repo, ws, base, worktree } = await setup();
    git(join(repo, worktree), "checkout", "--quiet", "-b", "elsewhere");
    const marker = join(repo, "hook-ran");
    mkdirSync(join(repo, ".git/hooks"), { recursive: true });
    for (const hook of ["post-commit", "pre-commit", "post-checkout"]) {
      writeFileSync(join(repo, ".git/hooks", hook), `#!/bin/sh\ntouch "${marker}"\n`);
      chmodSync(join(repo, ".git/hooks", hook), 0o755);
    }
    const head = await ws.snapshot(worktree, "vtc: T-1 round 1");
    expect(existsSync(marker)).toBe(false);
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(head);
    expect(git(repo, "rev-parse", "elsewhere")).toBe(base);
    await ws.ensureTaskWorktree("T-2", "vtc/T-2", base);
    expect(existsSync(marker)).toBe(false);
  });
  it("replaces a leftover directory that is no registered worktree; refuses a symlinked one", async () => {
    const repo = initRepo({ "a.txt": "1\n" });
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    writeFile(repo, ".vtc/state/worktrees/T-9/half-written.txt", "crash\n");
    const task = await ws.ensureTaskWorktree("T-9", "vtc/T-9", base);
    expect(existsSync(join(repo, task.worktree, "half-written.txt"))).toBe(false);
    expect(task.head).toBe(base);
    const elsewhere = tempDir("vtc-elsewhere-");
    rmSync(join(repo, task.worktree), { recursive: true, force: true });
    symlinkSync(elsewhere, join(repo, task.worktree));
    await expect(ws.snapshot(task.worktree, "x")).rejects.toThrow(WorktreeError);
    await expect(ws.discard(task.worktree, base)).rejects.toThrow(WorktreeError);
    expect(git(repo, "rev-parse", "main")).toBe(base);
  });
  it("removes a locked worktree and can create it again", async () => {
    const repo = initRepo({ "a.txt": "1\n" });
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    const task = await ws.ensureTaskWorktree("T-1", "vtc/T-1", base);
    expect(git(repo, "worktree", "list", "--porcelain")).toContain("locked");
    await ws.removeWorktree(task.worktree);
    expect(existsSync(join(repo, task.worktree))).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("T-1");
    expect(git(repo, "rev-parse", "vtc/T-1")).toBe(base);
    expect(await ws.ensureTaskWorktree("T-1", "vtc/T-1", base)).toEqual(task);
  });
  it("merges an exact commit, not whatever a branch points at", async () => {
    const repo = initRepo({ "a.txt": "1\n" });
    const ws = createWorkspace(repo);
    const base = await ws.resolve("HEAD");
    const f = await ws.ensureIntegration("F-1", "vtc/F-1", base);
    const t = await ws.ensureTaskWorktree("T-1", "vtc/T-1", base);
    writeFile(join(repo, t.worktree), "src/ok.ts", "ok\n");
    const gated = await ws.snapshot(t.worktree, "gated");
    writeFile(join(repo, t.worktree), "src/late.ts", "unreviewed\n");
    await ws.snapshot(t.worktree, "late");
    const merged = await ws.merge(f.worktree, gated, "Merge T-1");
    expect(merged.ok).toBe(true);
    if (merged.ok) {
      expect(git(repo, "rev-parse", `${merged.commit}^2`)).toBe(gated);
      expect(existsSync(join(repo, f.worktree, "src/late.ts"))).toBe(false);
    }
  });
});

describe("repo file writes never follow a symlink (AD-18)", () => {
  it("refuses a symlinked file or directory; writes and appends plain paths", () => {
    const repo = initRepo();
    const outside = tempDir("vtc-outside-");
    writeFileSync(join(outside, "victim.txt"), "original\n");
    mkdirSync(join(repo, ".vtc/tasks"), { recursive: true });
    symlinkSync(join(outside, "victim.txt"), join(repo, ".vtc/tasks/T-1.md"));
    writeRepoFile(repo, ".vtc/tasks/T-1.md", "plan\n");
    // the symlink itself is replaced; its target is untouched
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original\n");
    expect(readFileSync(join(repo, ".vtc/tasks/T-1.md"), "utf8")).toBe("plan\n");
    mkdirSync(join(repo, ".vtc/design"), { recursive: true });
    symlinkSync(outside, join(repo, ".vtc/design/reviews"));
    expect(() => {
      appendRepoFile(repo, ".vtc/design/reviews/login.jsonl", "{}\n");
    }).toThrow(UnsafePathError);
    expect(() => {
      writeRepoFile(repo, ".vtc/design/reviews/x.md", "x");
    }).toThrow(UnsafePathError);
    symlinkSync(join(outside, "victim.txt"), join(repo, ".vtc/log.jsonl"));
    expect(() => {
      appendRepoFile(repo, ".vtc/log.jsonl", "line\n");
    }).toThrow(UnsafePathError);
    expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("original\n");
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "a\n");
    appendRepoFile(repo, ".vtc/runs/r1/events.jsonl", "b\n");
    expect(readFileSync(join(repo, ".vtc/runs/r1/events.jsonl"), "utf8")).toBe("a\nb\n");
    expect(() => {
      writeRepoFile(repo, "../escape.txt", "x");
    }).toThrow(UnsafePathError);
  });
});

describe("pull requests via gh (parsing only; no network in tests)", () => {
  it.skipIf(process.platform === "win32")("kills a gh call that hangs", async () => {
    const dir = tempDir("vtc-gh-");
    const fake = join(dir, "gh");
    writeFileSync(fake, "#!/bin/sh\nsleep 30\n");
    chmodSync(fake, 0o755);
    const prs = createGhPullRequests(dir, fake, 200);
    const started = Date.now();
    expect(await prs.view("vtc/F-1")).toBeNull();
    expect(Date.now() - started).toBeLessThan(10_000);
  });
  it("maps gh JSON to a PullRequestRef", () => {
    const sha = "a".repeat(40);
    expect(
      pullRequestFromGh({
        url: "https://github.com/o/r/pull/1",
        isDraft: true,
        state: "OPEN",
        headRefOid: sha,
        statusCheckRollup: [],
      }),
    ).toEqual({
      url: "https://github.com/o/r/pull/1",
      draft: true,
      state: "open",
      head_sha: sha,
      ci: "unknown",
    });
    expect(
      pullRequestFromGh({
        url: "https://x/1",
        state: "MERGED",
        headRefOid: sha,
        mergeCommit: { oid: "b".repeat(40) },
      }),
    ).toMatchObject({ state: "merged", merge_commit: "b".repeat(40) });
    expect(pullRequestFromGh({})).toBeNull();
  });
  it("reads CI from the status rollup", () => {
    expect(ciFromRollup([{ conclusion: "SUCCESS" }, { conclusion: "SKIPPED" }])).toBe("green");
    expect(ciFromRollup([{ conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }])).toBe("pending");
    expect(ciFromRollup([{ conclusion: "FAILURE" }])).toBe("red");
    expect(ciFromRollup(undefined)).toBe("unknown");
  });
});
