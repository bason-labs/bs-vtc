/**
 * The frozen `GitOps` seam (AD-13 rule 4): diffs, base-commit reads and clean verification
 * checkouts, shared by engine core and the Gate Runner.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CreateGitOps, GitChangedFile, GitOps, GitSha, RelPath } from "@vtc/shared";
import { gitText, runGit, withRepoLock } from "./exec.js";

/** Clean verification checkouts live here (gitignored, §6.3 step 5). */
export const CHECKOUTS_DIR = ".vtc/state/checkouts";

const SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

const assertSha = (value: string): void => {
  if (!SHA.test(value)) throw new TypeError(`expected a full git sha, got ${value}`);
};

const STATUS: Readonly<Record<string, GitChangedFile["status"]>> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "added",
  T: "modified",
};

/** Parses `git diff --name-status -z -M` output. */
export const parseNameStatus = (raw: string): GitChangedFile[] => {
  const parts = raw.split("\0").filter((p) => p !== "");
  const files: GitChangedFile[] = [];
  for (let i = 0; i < parts.length;) {
    const code = parts[i] ?? "";
    const status = STATUS[code.charAt(0)] ?? "modified";
    if (code.startsWith("R") || code.startsWith("C")) {
      const oldPath = parts[i + 1] ?? "";
      const path = parts[i + 2] ?? "";
      files.push(code.startsWith("R") ? { path, status, oldPath } : { path, status: "added" });
      i += 3;
    } else {
      files.push({ path: parts[i + 1] ?? "", status });
      i += 2;
    }
  }
  return files.filter((f) => f.path !== "");
};

export const createGitOps: CreateGitOps = ({ repoRoot }): GitOps => ({
  changedFiles: async (base: GitSha, head: GitSha) => {
    assertSha(base);
    assertSha(head);
    const out = await runGit(repoRoot, ["diff", "--name-status", "-z", "-M", base, head]);
    return parseNameStatus(out.stdout.toString("utf8"));
  },
  diff: async (base: GitSha, head: GitSha, paths?: readonly RelPath[]) => {
    assertSha(base);
    assertSha(head);
    const args = ["diff", "--no-color", "--no-ext-diff", "-M", base, head];
    if (paths !== undefined) {
      if (paths.length === 0) return "";
      args.push("--", ...paths);
    }
    return (await runGit(repoRoot, args)).stdout.toString("utf8");
  },
  readFileAtCommit: async (commit: GitSha, path: RelPath) => {
    assertSha(commit);
    const spec = `${commit}:${path}`;
    const exists = await runGit(repoRoot, ["cat-file", "-e", spec], { allowFailure: true });
    if (exists.code !== 0) return undefined;
    const type = await gitText(repoRoot, ["cat-file", "-t", spec]);
    if (type !== "blob") return undefined;
    return new Uint8Array((await runGit(repoRoot, ["cat-file", "blob", spec])).stdout);
  },
  createCleanCheckout: (commit: GitSha) => {
    assertSha(commit);
    return withRepoLock(repoRoot, async () => {
      mkdirSync(join(repoRoot, CHECKOUTS_DIR), { recursive: true });
      const rel = `${CHECKOUTS_DIR}/${commit.slice(0, 12)}-${randomBytes(4).toString("hex")}`;
      await runGit(repoRoot, ["worktree", "add", "--detach", "--quiet", rel, commit]);
      return rel;
    });
  },
  removeCheckout: async (checkout: RelPath) => {
    if (!checkout.startsWith(`${CHECKOUTS_DIR}/`) || checkout.split("/").includes("..")) {
      throw new TypeError(`not a verification checkout: ${checkout}`);
    }
    await withRepoLock(repoRoot, () => removeCheckoutNow(repoRoot, checkout));
  },
});

const removeCheckoutNow = async (repoRoot: string, checkout: string): Promise<void> => {
  {
    await runGit(repoRoot, ["worktree", "remove", "--force", checkout], { allowFailure: true });
    if (existsSync(join(repoRoot, checkout))) {
      rmSync(join(repoRoot, checkout), { recursive: true, force: true });
    }
    await runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
  }
};
