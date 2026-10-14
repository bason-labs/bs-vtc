/**
 * `git.createGitPlumbing` (AD-13 rule 4, AD-27 rule 1; contracts 5.0.0 `GitPlumbing`): objects and
 * refs only, through a temporary index, against real temp repos and a local bare remote. No
 * network: the remote is a directory.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { autoBranchName, EVIDENCE_BRANCH, type CreateGitPlumbing } from "@vtc/shared";
import { createGitPlumbing } from "../../src/git/index.js";
import { addBareRemote, cleanupDirs, git, initRepo, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const FP = "0123456789abcdef";
const AUTO = `refs/heads/${autoBranchName("defect", FP)}`;
const EVIDENCE = `refs/heads/${EVIDENCE_BRANCH}`;

/** The repo's index and work tree, to show the plumbing changed neither. */
const snapshot = (repo: string): { status: string; index: string; head: string } => ({
  status: git(repo, "status", "--porcelain=v1", "--untracked-files=all"),
  index: readFileSync(join(repo, ".git/index")).toString("base64"),
  head: git(repo, "rev-parse", "HEAD"),
});

describe("git.createGitPlumbing (the frozen CreateGitPlumbing seam)", () => {
  it("has exactly the frozen type", () => {
    const create: CreateGitPlumbing = createGitPlumbing;
    expect(typeof create).toBe("function");
  });

  it("resolves a local ref to its commit, or null", async () => {
    const repo = initRepo();
    const plumbing = createGitPlumbing({ repoRoot: repo });
    expect(await plumbing.resolve("refs/heads/main")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(await plumbing.resolve("main")).toBe(git(repo, "rev-parse", "HEAD"));
    expect(await plumbing.resolve("refs/heads/nope")).toBeNull();
    expect(await plumbing.resolve("--all")).toBeNull();
  });

  it("commits base's tree with the changes applied, through a temporary index: no work-tree or index change", async () => {
    const repo = initRepo({ "README.md": "# app\n", "src/a.ts": "a\n", "src/b.ts": "b\n" });
    // the user's own uncommitted and staged work stays as it was
    writeFile(repo, "src/a.ts", "dirty\n");
    writeFile(repo, "staged.txt", "staged\n");
    git(repo, "add", "staged.txt");
    const before = snapshot(repo);
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const base = before.head;
    const sha = await plumbing.commit({
      base,
      parents: [base],
      changes: [
        { path: "src/b.ts", bytes: bytes("b2\n") },
        { path: "docs/new.md", bytes: bytes("new\n") },
        { path: "README.md", bytes: null },
      ],
      message: "vtc: automatic change\n\nbody line",
    });
    expect(sha).toMatch(/^[a-f0-9]{40}$/);
    expect(git(repo, "show", `${sha}:src/b.ts`)).toBe("b2");
    expect(git(repo, "show", `${sha}:docs/new.md`)).toBe("new");
    expect(git(repo, "show", `${sha}:src/a.ts`)).toBe("a");
    expect(git(repo, "ls-tree", "-r", "--name-only", sha)).not.toContain("README.md");
    expect(git(repo, "rev-parse", `${sha}^`)).toBe(base);
    expect(git(repo, "log", "-1", "--format=%B", sha)).toBe("vtc: automatic change\n\nbody line");
    expect(snapshot(repo)).toEqual(before);
    // no ref moved: the commit is only an object until updateRef or push names it
    expect(git(repo, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("commits an orphan (empty base, no parents) for the evidence branch", async () => {
    const repo = initRepo();
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x0a]);
    const sha = await plumbing.commit({
      base: null,
      parents: [],
      changes: [{ path: "abc123/01-replay.png", bytes: png }],
      message: "evidence",
    });
    expect(git(repo, "ls-tree", "-r", "--name-only", sha)).toBe("abc123/01-replay.png");
    expect(git(repo, "rev-list", "--count", sha)).toBe("1");
    const stored = git(repo, "cat-file", "-s", `${sha}:abc123/01-replay.png`);
    expect(Number(stored)).toBe(png.length);
  });

  it("refuses paths that leave the tree or name .git", async () => {
    const repo = initRepo();
    const plumbing = createGitPlumbing({ repoRoot: repo });
    for (const path of ["../x", "/abs", ".git/config", "a/.git/x", "a//b", ""])
      await expect(
        plumbing.commit({
          base: null,
          parents: [],
          changes: [{ path, bytes: bytes("x") }],
          message: "m",
        }),
      ).rejects.toThrow();
  });

  it("updates a ref only from the expected old value", async () => {
    const repo = initRepo();
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const head = git(repo, "rev-parse", "HEAD");
    const one = await plumbing.commit({
      base: head,
      parents: [head],
      changes: [{ path: "x", bytes: bytes("1") }],
      message: "1",
    });
    const two = await plumbing.commit({
      base: one,
      parents: [one],
      changes: [{ path: "x", bytes: bytes("2") }],
      message: "2",
    });
    await plumbing.updateRef(AUTO, one, null);
    expect(await plumbing.resolve(AUTO)).toBe(one);
    // a create when the ref exists, or an update from a stale value, fails
    await expect(plumbing.updateRef(AUTO, two, null)).rejects.toThrow();
    await expect(plumbing.updateRef(AUTO, two, head)).rejects.toThrow();
    await plumbing.updateRef(AUTO, two, one);
    expect(await plumbing.resolve(AUTO)).toBe(two);
  });

  it("writes no ref outside the automatic branches and the evidence branch", async () => {
    const repo = initRepo();
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const head = git(repo, "rev-parse", "HEAD");
    const sha = await plumbing.commit({
      base: head,
      parents: [head],
      changes: [{ path: "x", bytes: bytes("1") }],
      message: "1",
    });
    for (const ref of [
      "refs/heads/main",
      "refs/heads/feature",
      "HEAD",
      "refs/tags/v1",
      "vtc/auto/defect/01234567",
    ])
      await expect(plumbing.updateRef(ref, sha, null)).rejects.toThrow(/may not/);
    expect(git(repo, "rev-parse", "main")).toBe(head);
  });

  it("pushes without force to an automatic branch and to the evidence branch of a local bare remote", async () => {
    const repo = initRepo();
    const bare = addBareRemote(repo);
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const head = git(repo, "rev-parse", "HEAD");
    const one = await plumbing.commit({
      base: head,
      parents: [head],
      changes: [{ path: "x", bytes: bytes("1") }],
      message: "1",
    });
    await plumbing.push("origin", one, AUTO);
    expect(git(bare, "rev-parse", AUTO)).toBe(one);
    const orphan = await plumbing.commit({
      base: null,
      parents: [],
      changes: [{ path: "e/01-a.png", bytes: bytes("png") }],
      message: "e",
    });
    await plumbing.push("origin", orphan, EVIDENCE);
    expect(git(bare, "rev-parse", EVIDENCE)).toBe(orphan);
    // a non-fast-forward is refused: never forced
    const other = await plumbing.commit({
      base: head,
      parents: [head],
      changes: [{ path: "y", bytes: bytes("2") }],
      message: "2",
    });
    await expect(plumbing.push("origin", other, AUTO)).rejects.toThrow();
    expect(git(bare, "rev-parse", AUTO)).toBe(one);
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(head);
  });

  it("refuses a push to the default branch, to any branch autoPushRefAllowed rejects, or with an option for a remote", async () => {
    const repo = initRepo();
    const bare = addBareRemote(repo);
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const head = git(repo, "rev-parse", "HEAD");
    const sha = await plumbing.commit({
      base: head,
      parents: [head],
      changes: [{ path: "x", bytes: bytes("1") }],
      message: "1",
    });
    for (const dst of [
      "refs/heads/main",
      "main",
      "refs/heads/feature",
      "refs/tags/v1",
      `+${AUTO}`,
      "vtc/auto/defect/01234567",
    ])
      await expect(plumbing.push("origin", sha, dst)).rejects.toThrow(/may not push/);
    await expect(plumbing.push("--force", sha, AUTO)).rejects.toThrow();
    await expect(plumbing.push("origin", "main", AUTO)).rejects.toThrow();
    expect(git(bare, "rev-parse", "refs/heads/main")).toBe(head);
    expect(git(bare, "for-each-ref", "--format=%(refname)")).toBe("refs/heads/main");
  });

  it("refuses an automatic branch that is the remote's default branch", async () => {
    const repo = initRepo();
    const bare = addBareRemote(repo);
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const head = git(repo, "rev-parse", "HEAD");
    // someone made the evidence branch the remote's default
    git(repo, "push", "--quiet", "origin", `${head}:${EVIDENCE}`);
    git(bare, "symbolic-ref", "HEAD", EVIDENCE);
    const sha = await plumbing.commit({
      base: head,
      parents: [head],
      changes: [{ path: "x", bytes: bytes("1") }],
      message: "1",
    });
    await expect(plumbing.push("origin", sha, EVIDENCE)).rejects.toThrow(/default branch/);
    expect(git(bare, "rev-parse", EVIDENCE)).toBe(head);
  });

  it("refuses a push when the remote names no default branch (the first branch pushed to an empty repo becomes its default)", async () => {
    const repo = initRepo();
    const empty = join(repo, "..", `${String(Date.now())}-empty.git`);
    git(join(repo, ".."), "init", "--quiet", "--bare", empty);
    git(repo, "remote", "add", "empty", empty);
    const plumbing = createGitPlumbing({ repoRoot: repo });
    const sha = await plumbing.commit({
      base: null,
      parents: [],
      changes: [{ path: "x", bytes: bytes("1") }],
      message: "1",
    });
    await expect(plumbing.push("empty", sha, EVIDENCE)).rejects.toThrow(/default branch/);
  });

  it("uses the user's own signing setting: no -c override of commit.gpgsign", async () => {
    const repo = initRepo();
    // a signing program that records it ran and fails, so a signed commit attempt is visible
    const marker = join(repo, "..", `${String(Date.now())}-signed`);
    const program = join(repo, "..", `${String(Date.now())}-gpg.sh`);
    writeFileSync(program, `#!/bin/sh\necho ran > '${marker}'\nexit 1\n`, { mode: 0o755 });
    git(repo, "config", "gpg.program", program);
    git(repo, "config", "commit.gpgsign", "true");
    const plumbing = createGitPlumbing({ repoRoot: repo });
    await expect(
      plumbing.commit({
        base: null,
        parents: [],
        changes: [{ path: "x", bytes: bytes("1") }],
        message: "1",
      }),
    ).rejects.toThrow();
    expect(readFileSync(marker, "utf8")).toBe("ran\n");
    git(repo, "config", "commit.gpgsign", "false");
    await expect(
      plumbing.commit({
        base: null,
        parents: [],
        changes: [{ path: "x", bytes: bytes("1") }],
        message: "1",
      }),
    ).resolves.toMatch(/^[a-f0-9]{40}$/);
  });
});
