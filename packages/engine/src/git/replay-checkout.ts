/**
 * Clean checkouts for Lookback replay trials (AD-21 rule 6, spine §5 reading 176): a standalone
 * repository at the recorded dispatch's base commit, with no refs past it. It is not a worktree of
 * the user's repo (a worktree shares every ref and object, so a trial could read the work that came
 * after its base): the objects reachable from the base are fetched into a fresh repository whose
 * git directory lives outside the checkout, in the engine's private directory, where no role can
 * plant a hook or a config key; every git call names that directory and the checkout explicitly
 * (and, like every engine git call, runs no hook). The trial's work is committed there (its head)
 * so the Gate Runner can grade `base..head` in the checkout; then both directories are removed.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { assertNoSymlinks } from "./repo-files.js";
import { gitText, runGit, withRepoLock } from "./exec.js";

const SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

/** The identity of the engine's trial commits (never the user's). */
const TRIAL_IDENTITY = {
  GIT_AUTHOR_NAME: "VTC Engine",
  GIT_AUTHOR_EMAIL: "vtc@localhost",
  GIT_COMMITTER_NAME: "VTC Engine",
  GIT_COMMITTER_EMAIL: "vtc@localhost",
} as const;

export interface ReplayCheckout {
  /** The checkout, relative to the repo root. */
  readonly path: string;
  /** The checkout's git directory (absolute, in the engine's private directory). */
  readonly gitDir: string;
  /** The commit it starts from. */
  readonly base: string;
}

const args = (repoRoot: string, checkout: ReplayCheckout): string[] => [
  `--git-dir=${checkout.gitDir}`,
  `--work-tree=${join(repoRoot, checkout.path)}`,
];

/**
 * Creates the checkout at `base` (replacing a leftover one at the same paths). The base must be a
 * commit of the user's repo; a temporary ref there is the only way to fetch it, and it is deleted
 * again before this returns.
 */
export const createReplayCheckout = async (
  repoRoot: string,
  checkout: ReplayCheckout,
): Promise<void> => {
  if (!SHA.test(checkout.base))
    throw new TypeError(`expected a full git sha, got ${checkout.base}`);
  assertNoSymlinks(repoRoot, checkout.path);
  removeReplayCheckout(repoRoot, checkout);
  const tree = join(repoRoot, checkout.path);
  mkdirSync(tree, { recursive: true });
  mkdirSync(dirname(checkout.gitDir), { recursive: true, mode: 0o700 });
  await runGit(tree, ["init", "--quiet", `--separate-git-dir=${checkout.gitDir}`, tree]);
  const ref = `refs/vtc/replay-${randomBytes(6).toString("hex")}`;
  await withRepoLock(repoRoot, () => runGit(repoRoot, ["update-ref", ref, checkout.base]));
  try {
    await runGit(tree, [
      ...args(repoRoot, checkout),
      "fetch",
      "--quiet",
      "--no-tags",
      repoRoot,
      ref,
    ]);
  } finally {
    await withRepoLock(repoRoot, () =>
      runGit(repoRoot, ["update-ref", "-d", ref], { allowFailure: true }),
    );
  }
  await runGit(tree, [
    ...args(repoRoot, checkout),
    "checkout",
    "--quiet",
    "--detach",
    checkout.base,
  ]);
};

/** Commits what the trial left in the checkout; its head (the base when it changed nothing). */
export const snapshotReplayCheckout = async (
  repoRoot: string,
  checkout: ReplayCheckout,
  message: string,
): Promise<string> => {
  const tree = join(repoRoot, checkout.path);
  const git = args(repoRoot, checkout);
  await runGit(tree, [...git, "add", "--all"]);
  const staged = await runGit(tree, [...git, "diff", "--cached", "--quiet"], {
    allowFailure: true,
  });
  if (staged.code !== 0)
    await runGit(
      tree,
      [...git, "commit", "--quiet", "--no-verify", "--no-gpg-sign", "-m", message],
      {
        env: TRIAL_IDENTITY,
      },
    );
  return gitText(tree, [...git, "rev-parse", "HEAD"]);
};

/** Removes the checkout and its git directory (best effort; a missing one is fine). */
export const removeReplayCheckout = (repoRoot: string, checkout: ReplayCheckout): void => {
  const tree = join(repoRoot, checkout.path);
  if (existsSync(tree)) rmSync(tree, { recursive: true, force: true });
  if (existsSync(checkout.gitDir)) rmSync(checkout.gitDir, { recursive: true, force: true });
};
