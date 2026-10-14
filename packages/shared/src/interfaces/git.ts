/**
 * Git seam (AD-13 rule 4). The engine's `git/` module (engine-core team, sub-project 1)
 * implements it as `git.createGitOps`; the cli builds one and injects it into the Gate Runner
 * (`GateRunnerDeps.git`), so the gate-runner team never writes git code and both teams share one
 * implementation. Worktrees, branches, the submit snapshot commit and merges stay internal to
 * engine core. Every call uses the user's own git and auth (AD-9).
 */
import type { BaseRun, MergeMethod, RemoteMergePolicy, RevertRef } from "../auto-merge.js";
import type { PullRequestRef, RequiredCheck } from "../feature.js";
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

/** What the engine asks for when it opens or updates the feature's PR (§6.7 Level 2). */
export interface PullRequestRequest {
  /** The integration branch, `vtc/F-n` (`integrationBranchFor`). */
  readonly branch: string;
  /** The branch the PR targets (the repo's default branch). */
  readonly base: string;
  readonly title: string;
  /** The PR description (the feature evidence bundle summary at release, §6.7a). */
  readonly body: string;
}

/**
 * The feature's PR (§6.7), behind an interface so engine core and its tests never need the
 * network. The default implementation drives the user's own `gh` CLI with the user's existing
 * auth (AD-9, §15); VTC never handles a token. Errors reject; the engine records them as
 * `feature.pr_failed`.
 */
export interface PullRequestService {
  /** Opens the draft PR for `request.branch`, or returns (and re-describes) the open one. */
  upsertDraft(request: PullRequestRequest): Promise<PullRequestRef>;
  /** Marks the PR ready for review (after Final Review passes). */
  markReady(branch: string): Promise<PullRequestRef>;
  /** The PR as it is now (state, head, CI), or `null` when there is none. */
  view(branch: string): Promise<PullRequestRef | null>;
}

/** The remote and the user's `gh` login, for the Level-3 preflight (AD-23 rule 1). */
export interface RemoteInfo {
  /** The push remote is on GitHub. */
  readonly github: boolean;
  /** `gh auth status` exits 0 (no token is read). */
  readonly ghAuthenticated: boolean;
}

/**
 * Level-3 auto-merge and the post-merge watch (spec §6.7, AD-23), behind an interface so engine
 * core and its tests never need the network. A separate, optional seam (`EngineDeps.remoteMerge`)
 * keeps {@link PullRequestService} unchanged. The cli injects the `gh`-backed implementation; it
 * uses the user's own `gh` auth, never passes `GH_FORBIDDEN_ARGS` (`--admin`), never changes repo
 * settings and never pushes to the base branch. Without it, Level 3 is unavailable and the
 * effective level is 2. New in contracts 4.5.0.
 */
export interface RemoteMergeService {
  /** Whether the remote is GitHub and `gh` is logged in. */
  remote(): Promise<RemoteInfo>;
  /** What the remote enforces on `base` (rules API, then classic branch protection). */
  policy(base: string): Promise<RemoteMergePolicy>;
  /** The base's required checks on the PR head `sha` of `branch` (`gh pr checks --required`). */
  requiredChecks(branch: string, sha: string): Promise<readonly RequiredCheck[]>;
  /**
   * `gh pr merge <n> --auto --match-head-commit <headSha> --<method>`: GitHub merges only while
   * the PR head is still `headSha` (the commit the gates verified) and the requirements pass.
   */
  enableAutoMerge(request: {
    readonly branch: string;
    readonly headSha: string;
    readonly method: MergeMethod;
  }): Promise<PullRequestRef>;
  /** `gh pr merge <n> --disable-auto` (`vtc pause`, a moved head); `null` when no PR exists. */
  disableAutoMerge(branch: string): Promise<PullRequestRef | null>;
  /** CI runs on `base` for the merge commit `sha` (`gh run list --branch --commit`). */
  baseRuns(base: string, sha: string): Promise<readonly BaseRun[]>;
  /**
   * Reverts of `mergeCommit` on `base`: `git log <merge>..origin/<base>` for "This reverts commit
   * <sha>", a PR that names `prNumber`, or an inverse patch-id match.
   */
  findReverts(
    base: string,
    mergeCommit: string,
    prNumber: number | null,
  ): Promise<readonly RevertRef[]>;
}
