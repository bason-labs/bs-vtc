/**
 * Worktrees, branches, submit snapshots and merges (§6.6, §6.7; AD-8 rules 4 and 14). Internal to
 * engine core (AD-13 rule 4): only the merge queue merges, and only engine core commits a role's
 * work. Each task works in `.vtc/state/worktrees/T-n` on `vtc/T-n`; each feature integrates in
 * `.vtc/state/worktrees/F-n` on `vtc/F-n`, so the user's own checkout is never touched.
 *
 * Agents work inside these worktrees and can delete or rewrite the `.git` file there. Git would
 * then walk up to the user's checkout, or read a repository (config, hooks, fsmonitor) the agent
 * controls. So no engine command trusts that file: every worktree command pins the repository
 * with `--git-dir` (the worktree's admin directory under the repo's own common git dir, found by
 * its `gitdir` back-pointer) and `--work-tree`, refuses a worktree path that is or passes through
 * a symlink, repairs the `.git` file, and keeps HEAD on the worktree's own branch. Worktrees are
 * created locked, so `git worktree prune` never drops one whose `.git` file an agent deleted.
 */
import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { gitText, runGit, withRepoLock } from "./exec.js";
import { assertNoSymlinks, ensureRepoDir } from "./repo-files.js";

export const WORKTREES_DIR = ".vtc/state/worktrees";

/** Engine commits use the repo's configured identity, or this one when none is set. */
const FALLBACK_IDENTITY = { name: "VTC Engine", email: "vtc@localhost" } as const;

const SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

export type MergeOutcome =
  | { readonly ok: true; readonly commit: string }
  | { readonly ok: false; readonly conflict: boolean; readonly detail: string };

/** A worktree path the engine cannot pin to this repo (missing, unregistered, a symlink). */
export class WorktreeError extends Error {
  constructor(
    readonly worktree: string,
    detail: string,
  ) {
    super(`worktree ${worktree}: ${detail}`);
    this.name = "WorktreeError";
  }
}

export interface Workspace {
  readonly repoRoot: string;
  /** Full sha of a ref or commit. */
  resolve(ref: string): Promise<string>;
  /** True when `ref` names an existing branch. */
  branchExists(branch: string): Promise<boolean>;
  /**
   * The feature's integration branch and its worktree: creates `branch` (`vtc/<id>`) at `base`
   * and checks it out in `.vtc/state/worktrees/<id>` when missing. Returns the worktree and the
   * branch head.
   */
  ensureIntegration(
    id: string,
    branch: string,
    base: string,
  ): Promise<{ worktree: string; head: string }>;
  /** The task's worktree on a new branch `vtc/<id>` at `base` (or the existing one). */
  ensureTaskWorktree(
    id: string,
    branch: string,
    base: string,
  ): Promise<{ worktree: string; head: string }>;
  /**
   * Commits everything in the worktree onto its branch (AD-8 rule 14: roles never need to
   * commit) and returns the new head; the current head when nothing changed.
   */
  snapshot(worktree: string, message: string): Promise<string>;
  /** True when the worktree has uncommitted changes (tracked or untracked). */
  isDirty(worktree: string): Promise<boolean>;
  /** Throws away uncommitted changes and commits: the branch back to `head`, untracked removed. */
  discard(worktree: string, head: string): Promise<void>;
  /** The tree id of a commit (stuck detection: identical diff = identical tree). */
  treeOf(commit: string): Promise<string>;
  /** Rebases the task worktree's branch onto `onto`; aborts and reports a conflict. */
  rebase(worktree: string, onto: string): Promise<MergeOutcome>;
  /**
   * Merges `commit` (a full sha, or a branch) into the integration worktree with a merge commit;
   * aborts on conflict.
   */
  merge(worktree: string, commit: string, message: string): Promise<MergeOutcome>;
  /** True when `ancestor` is reachable from `commit`. */
  isAncestor(ancestor: string, commit: string): Promise<boolean>;
  /** `git push <remote> <branch>` with the user's own auth (never force). */
  push(remote: string, branch: string): Promise<{ ok: boolean; detail: string }>;
  /** The URL of a remote, or `null` when it is not configured. */
  remoteUrl(remote: string): Promise<string | null>;
  removeWorktree(worktree: string): Promise<void>;
}

/** A path with every existing prefix resolved through `realpath` (macOS `/var` → `/private/var`). */
const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), basename(path));
  }
};

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

const isPlainDir = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
};

interface Pinned {
  /** `--git-dir`/`--work-tree` arguments for every git call on this worktree. */
  readonly args: readonly string[];
  readonly cwd: string;
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
  let common: Promise<string> | undefined;
  /** The repo's own common git dir (read from the user's checkout, where no agent works). */
  const commonDir = (): Promise<string> =>
    (common ??= (async () => {
      const out = await gitText(repoRoot, ["rev-parse", "--git-common-dir"]);
      return canonical(isAbsolute(out) ? out : resolvePath(repoRoot, out));
    })());
  const abs = (rel: string): string => join(repoRoot, rel);
  const locked =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      withRepoLock(repoRoot, () => fn(...args));

  /** The admin dir (`<common>/worktrees/<name>`) whose `gitdir` points at `worktree`, if any. */
  const adminDirFor = async (worktree: string): Promise<string | null> => {
    const dir = join(await commonDir(), "worktrees");
    if (!existsSync(dir)) return null;
    const want = canonical(abs(worktree));
    for (const name of readdirSync(dir)) {
      let pointer: string;
      try {
        pointer = readFileSync(join(dir, name, "gitdir"), "utf8").trim();
      } catch {
        continue;
      }
      if (pointer === "") continue;
      const target = isAbsolute(pointer) ? pointer : resolvePath(join(dir, name), pointer);
      if (canonical(dirname(target)) === want) return join(dir, name);
    }
    return null;
  };

  /**
   * Pins `worktree` to its registered admin dir, repairs its `.git` file and keeps HEAD on
   * `vtc/<id>`. Throws a {@link WorktreeError} when the path is not a registered worktree.
   */
  const pin = async (worktree: string): Promise<Pinned> => {
    const id = worktree.startsWith(`${WORKTREES_DIR}/`)
      ? worktree.slice(WORKTREES_DIR.length + 1)
      : "";
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
      throw new WorktreeError(worktree, "not an engine worktree path");
    try {
      assertNoSymlinks(repoRoot, worktree);
    } catch (error) {
      throw new WorktreeError(worktree, error instanceof Error ? error.message : String(error));
    }
    const cwd = abs(worktree);
    if (!isPlainDir(cwd)) throw new WorktreeError(worktree, "the worktree directory is missing");
    const admin = await adminDirFor(worktree);
    if (admin === null) throw new WorktreeError(worktree, "not a registered worktree of this repo");
    const dotGit = join(cwd, ".git");
    const expected = `gitdir: ${admin}\n`;
    const intact = ((): boolean => {
      try {
        return lstatSync(dotGit).isFile() && readFileSync(dotGit, "utf8") === expected;
      } catch {
        return false;
      }
    })();
    if (!intact) {
      rmSync(dotGit, { recursive: true, force: true });
      writeFileSync(dotGit, expected, { flag: "wx" });
    }
    const args = [`--git-dir=${admin}`, `--work-tree=${cwd}`];
    const branch = `refs/heads/vtc/${id}`;
    const head = await runGit(cwd, [...args, "symbolic-ref", "-q", "HEAD"], { allowFailure: true });
    if (head.stdout.toString("utf8").trim() !== branch) {
      // Commits land on the worktree's own branch, whatever an agent checked out.
      await runGit(cwd, [...args, "symbolic-ref", "HEAD", branch]);
    }
    return { args, cwd };
  };

  const git = async (
    p: Pinned,
    args: readonly string[],
    options: { env?: Record<string, string>; allowFailure?: boolean } = {},
  ) => runGit(p.cwd, [...p.args, ...args], options);
  const gitOut = (p: Pinned, args: readonly string[]): Promise<string> =>
    gitText(p.cwd, [...p.args, ...args]);

  const branchExists = async (branch: string): Promise<boolean> =>
    (
      await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {
        allowFailure: true,
      })
    ).code === 0;

  /** Drops a registration or directory that cannot be used (e.g. a crash mid-`worktree add`). */
  const dropBroken = async (worktree: string): Promise<void> => {
    await runGit(repoRoot, ["worktree", "unlock", worktree], { allowFailure: true });
    if (existsSync(abs(worktree)) || isSymlink(abs(worktree)))
      rmSync(abs(worktree), { recursive: true, force: true });
    await runGit(repoRoot, ["worktree", "prune"], { allowFailure: true });
  };

  const ensureWorktree = async (
    id: string,
    branch: string,
    base: string,
  ): Promise<{ worktree: string; head: string }> => {
    if (branch !== `vtc/${id}`) throw new WorktreeError(id, `branch ${branch} is not vtc/${id}`);
    const worktree = `${WORKTREES_DIR}/${id}`;
    let pinned: Pinned;
    try {
      pinned = await pin(worktree);
    } catch (error) {
      if (!(error instanceof WorktreeError)) throw error;
      await dropBroken(worktree);
      ensureRepoDir(repoRoot, WORKTREES_DIR);
      await runGit(
        repoRoot,
        (await branchExists(branch))
          ? ["worktree", "add", "--quiet", "--lock", worktree, branch]
          : ["worktree", "add", "--quiet", "--lock", "-b", branch, worktree, base],
      );
      pinned = await pin(worktree);
    }
    return { worktree, head: await gitOut(pinned, ["rev-parse", "HEAD"]) };
  };

  return {
    repoRoot,
    resolve: (ref) => gitText(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]),
    branchExists,
    ensureIntegration: locked(ensureWorktree),
    ensureTaskWorktree: locked(ensureWorktree),
    snapshot: locked(async (worktree: string, message: string) => {
      const p = await pin(worktree);
      await git(p, ["add", "--all"]);
      const staged = await git(p, ["diff", "--cached", "--quiet"], { allowFailure: true });
      if (staged.code !== 0) {
        await git(p, ["commit", "--quiet", "--no-verify", "-m", message], {
          env: await commitEnv(),
        });
      }
      return gitOut(p, ["rev-parse", "HEAD"]);
    }),
    isDirty: locked(
      async (worktree: string) =>
        (await gitOut(await pin(worktree), ["status", "--porcelain", "--untracked-files=all"])) !==
        "",
    ),
    discard: locked(async (worktree: string, head: string) => {
      if (!SHA.test(head)) throw new TypeError(`expected a full git sha, got ${head}`);
      const p = await pin(worktree);
      await git(p, ["reset", "--hard", "--quiet", head]);
      await git(p, ["clean", "-fd", "--quiet"]);
    }),
    treeOf: (commit) => gitText(repoRoot, ["rev-parse", `${commit}^{tree}`]),
    rebase: locked(async (worktree: string, onto: string): Promise<MergeOutcome> => {
      const p = await pin(worktree);
      const result = await git(p, ["rebase", "--quiet", onto], {
        allowFailure: true,
        env: await commitEnv(),
      });
      if (result.code !== 0) {
        await git(p, ["rebase", "--abort"], { allowFailure: true });
        return { ok: false, conflict: true, detail: result.stderr.trim().slice(0, 500) };
      }
      return { ok: true, commit: await gitOut(p, ["rev-parse", "HEAD"]) };
    }),
    merge: locked(
      async (worktree: string, commit: string, message: string): Promise<MergeOutcome> => {
        const p = await pin(worktree);
        const result = await git(
          p,
          ["merge", "--no-ff", "--no-verify", "--quiet", "-m", message, commit],
          { allowFailure: true, env: await commitEnv() },
        );
        if (result.code !== 0) {
          await git(p, ["merge", "--abort"], { allowFailure: true });
          return { ok: false, conflict: true, detail: result.stderr.trim().slice(0, 500) };
        }
        return { ok: true, commit: await gitOut(p, ["rev-parse", "HEAD"]) };
      },
    ),
    isAncestor: async (ancestor, commit) =>
      (
        await runGit(repoRoot, ["merge-base", "--is-ancestor", ancestor, commit], {
          allowFailure: true,
        })
      ).code === 0,
    push: locked(async (remote: string, branch: string) => {
      const result = await runGit(repoRoot, ["push", "--quiet", remote, `${branch}:${branch}`], {
        allowFailure: true,
        hooks: true,
      });
      return { ok: result.code === 0, detail: result.stderr.trim().slice(0, 500) };
    }),
    remoteUrl: async (remote) => {
      const url = await gitText(repoRoot, ["remote", "get-url", remote], { allowFailure: true });
      return url === "" ? null : url;
    },
    removeWorktree: locked(async (worktree: string) => {
      await runGit(repoRoot, ["worktree", "remove", "--force", "--force", worktree], {
        allowFailure: true,
      });
      await dropBroken(worktree);
    }),
  };
};
