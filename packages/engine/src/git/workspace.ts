/**
 * Worktrees, branches, submit snapshots and merges (§6.6, §6.7; AD-8 rules 4 and 14). Internal to
 * engine core (AD-13 rule 4): only the merge queue merges, and only engine core commits a role's
 * work. Each task works in `.vtc/state/worktrees/T-n` on `vtc/T-n`; each feature integrates in
 * `.vtc/state/worktrees/F-n` on `vtc/F-n`, so the user's own checkout is never touched.
 */
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gitText, runGit } from "./exec.js";

export const WORKTREES_DIR = ".vtc/state/worktrees";

/** Engine commits use the repo's configured identity, or this one when none is set. */
const FALLBACK_IDENTITY = { name: "VTC Engine", email: "vtc@localhost" } as const;

export type MergeOutcome =
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly conflict: boolean; readonly detail: string };

export interface Workspace {
  readonly repoRoot: string;
  /** Full sha of a ref or commit. */
  resolve(ref: string): Promise<string>;
  /** True when `ref` names an existing branch. */
  branchExists(branch: string): Promise<boolean>;
  /**
   * The feature's integration branch and its worktree: creates `branch` at `base` and checks it out
   * in `.vtc/state/worktrees/<id>` when missing. Returns the worktree and the branch head.
   */
  ensureIntegration(id: string, branch: string, base: string): Promise<{ worktree: string; head: string }>;
  /** The task's worktree on a new branch at `base` (or the existing one). */
  ensureTaskWorktree(id: string, branch: string, base: string): Promise<{ worktree: string; head: string }>;
  /**
   * Commits everything in the worktree (AD-8 rule 14: roles never need to commit) and returns the
   * new head; the current head when nothing changed.
   */
  snapshot(worktree: string, message: string): Promise<string>;
  /** True when the worktree has uncommitted changes (tracked or untracked). */
  isDirty(worktree: string): Promise<boolean>;
  /** Throws away uncommitted changes: back to `head`, untracked files removed. */
  discard(worktree: string, head: string): Promise<void>;
  /** The tree id of a commit (stuck detection: identical diff = identical tree). */
  treeOf(commit: string): Promise<string>;
  /** Rebases the task worktree's branch onto `onto`; aborts and reports a conflict. */
  rebase(worktree: string, onto: string): Promise<MergeOutcome>;
  /** Merges `branch` into the integration worktree with a merge commit; aborts on conflict. */
  merge(worktree: string, branch: string, message: string): Promise<MergeOutcome>;
  /** True when `ancestor` is reachable from `commit`. */
  isAncestor(ancestor: string, commit: string): Promise<boolean>;
  /** `git push <remote> <branch>` with the user's own auth (never force). */
  push(remote: string, branch: string): Promise<{ ok: boolean; detail: string }>;
  /** The URL of a remote, or `null` when it is not configured. */
  remoteUrl(remote: string): Promise<string | null>;
  removeWorktree(worktree: string): Promise<void>;
}

export const createWorkspace = (repoRoot: string): Workspace => {
  let identity: Promise<Record<string, string>> | undefined;
  const commitEnv = (): Promise<Record<string, string>> =>
    (identity ??= (async () => {
      const email = await gitText(repoRoot, ["config", "user.email"], { allowFailure: true });
      if (email !== "") return {};
      return {
        GIT_AUTHOR_NAME: FALLBACK_IDENTITY.name,
        GIT_AUTHOR_EMAIL: FALLBACK_IDENTITY.email,
        GIT_COMMITTER_NAME: FALLBACK_IDENTITY.name,
        GIT_COMMITTER_EMAIL: FALLBACK_IDENTITY.email,
      };
    })());
  const abs = (rel: string): string => join(repoRoot, rel);
  const ensureWorktree = async (
    id: string,
    branch: string,
    base: string,
  ): Promise<{ worktree: string; head: string }> => {
    const worktree = `${WORKTREES_DIR}/${id}`;
    if (!existsSync(abs(worktree))) {
      mkdirSync(abs(WORKTREES_DIR), { recursive: true });
      const exists = await branchExists(branch);
      await runGit(
        repoRoot,
        exists
          ? ["worktree", "add", "--quiet", worktree, branch]
          : ["worktree", "add", "--quiet", "-b", branch, worktree, base],
      );
    }
    return { worktree, head: await gitText(abs(worktree), ["rev-parse", "HEAD"]) };
  };
  const branchExists = async (branch: string): Promise<boolean> =>
    (
      await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        allowFailure: true,
      })
    ).code === 0;
  return {
    repoRoot,
    resolve: (ref) => gitText(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]),
    branchExists,
    ensureIntegration: ensureWorktree,
    ensureTaskWorktree: ensureWorktree,
    snapshot: async (worktree, message) => {
      const cwd = abs(worktree);
      await runGit(cwd, ["add", "--all"]);
      const staged = await runGit(cwd, ["diff", "--cached", "--quiet"], { allowFailure: true });
      if (staged.code !== 0) {
        await runGit(cwd, ["commit", "--quiet", "--no-verify", "-m", message], {
          env: await commitEnv(),
        });
      }
      return gitText(cwd, ["rev-parse", "HEAD"]);
    },
    isDirty: async (worktree) =>
      (await gitText(abs(worktree), ["status", "--porcelain", "--untracked-files=all"])) !== "",
    discard: async (worktree, head) => {
      await runGit(abs(worktree), ["reset", "--hard", "--quiet", head]);
      await runGit(abs(worktree), ["clean", "-fd", "--quiet"]);
    },
    treeOf: (commit) => gitText(repoRoot, ["rev-parse", `${commit}^{tree}`]),
    rebase: async (worktree, onto) => {
      const cwd = abs(worktree);
      const result = await runGit(cwd, ["rebase", "--quiet", onto], {
        allowFailure: true,
        env: await commitEnv(),
      });
      if (result.code !== 0) {
        await runGit(cwd, ["rebase", "--abort"], { allowFailure: true });
        return { ok: false, conflict: true, detail: result.stderr.trim().slice(0, 500) };
      }
      return { ok: true, commit: await gitText(cwd, ["rev-parse", "HEAD"]) };
    },
    merge: async (worktree, branch, message) => {
      const cwd = abs(worktree);
      const result = await runGit(
        cwd,
        ["merge", "--no-ff", "--no-verify", "--quiet", "-m", message, branch],
        { allowFailure: true, env: await commitEnv() },
      );
      if (result.code !== 0) {
        await runGit(cwd, ["merge", "--abort"], { allowFailure: true });
        return { ok: false, conflict: true, detail: result.stderr.trim().slice(0, 500) };
      }
      return { ok: true, commit: await gitText(cwd, ["rev-parse", "HEAD"]) };
    },
    isAncestor: async (ancestor, commit) =>
      (
        await runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, commit], {
          allowFailure: true,
        })
      ).code === 0,
    push: async (remote, branch) => {
      const result = await runGit(repoRoot, ["push", "--quiet", remote, `${branch}:${branch}`], {
        allowFailure: true,
      });
      return { ok: result.code === 0, detail: result.stderr.trim().slice(0, 500) };
    },
    remoteUrl: async (remote) => {
      const url = await gitText(repoRoot, ["remote", "get-url", remote], { allowFailure: true });
      return url === "" ? null : url;
    },
    removeWorktree: async (worktree) => {
      await runGit(repoRoot, ["worktree", "remove", "--force", worktree], { allowFailure: true });
      if (existsSync(abs(worktree))) rmSync(abs(worktree), { recursive: true, force: true });
      await runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
    },
  };
};
