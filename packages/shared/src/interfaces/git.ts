/**
 * Git seam (AD-13 rule 4). The engine's `git/` module (engine-core team, sub-project 1)
 * implements it as `git.createGitOps`; the cli builds one and injects it into the Gate Runner
 * (`GateRunnerDeps.git`), so the gate-runner team never writes git code and both teams share one
 * implementation. Worktrees, branches, the submit snapshot commit and merges stay internal to
 * engine core. Every call uses the user's own git and auth (AD-9).
 */
import type { GitSha, RelPath } from "../primitives.js";

/** One changed file between two commits (renames detected). */
export interface GitChangedFile {
  readonly path: RelPath;
  readonly status: "added" | "modified" | "deleted" | "renamed";
  /** The path before a rename. */
  readonly oldPath?: RelPath;
}

export interface GitOps {
  /**
   * Files changed from `base` to `head` (`git diff --name-status -M base head`): the input of the
   * write-scope check, affected-only test selection and L1's changed-file lint (§7.2).
   */
  changedFiles(base: GitSha, head: GitSha): Promise<readonly GitChangedFile[]>;
  /** Unified diff text from `base` to `head`, optionally limited to `paths` (L5 skip/suppression scan). */
  diff(base: GitSha, head: GitSha, paths?: readonly RelPath[]): Promise<string>;
  /**
   * A file's bytes at a commit, or `undefined` when it does not exist there: L1 lints with the
   * base commit's config (§7.2), L5 checksums protected files.
   */
  readFileAtCommit(commit: GitSha, path: RelPath): Promise<Uint8Array | undefined>;
  /**
   * A clean, detached checkout of `commit` (§6.3 step 5) under `.vtc/state/checkouts/`, with no
   * untracked or ignored files; returns its repo-relative path.
   */
  createCleanCheckout(commit: GitSha): Promise<RelPath>;
  /** Removes a checkout made by `createCleanCheckout`. Idempotent. */
  removeCheckout(checkout: RelPath): Promise<void>;
}

export interface GitOpsDeps {
  /** Absolute repo root. */
  readonly repoRoot: string;
}

/** Implemented by the engine-core team in `@vtc/engine` (`git.createGitOps`). */
export type CreateGitOps = (deps: GitOpsDeps) => GitOps;
