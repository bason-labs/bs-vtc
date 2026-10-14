/**
 * Git, worktrees and clean verification checkouts (AD-13 rule 4; owner: engine-core team,
 * sub-project 1). Implements the frozen `GitOps` seam from @vtc/shared (`createGitOps`), which the
 * cli builds and injects into the Gate Runner (`GateRunnerDeps.git`); engine core also uses it for
 * worktrees, the submit snapshot commit (`role.submitted.head`) and the merge queue. Imports no
 * other engine module. Uses the user's own git auth (AD-9). Also home of the engine's repo file
 * writes that never follow a symlink (`writeRepoFile`, `appendRepoFile`), and of the automation's
 * local git plumbing (`createGitPlumbing`, the frozen `CreateGitPlumbing` seam, AD-27 rule 1) and its
 * fetch of the shared automation branches (`createRemoteRefs`).
 */
export { createGitOps, parseNameStatus, CHECKOUTS_DIR } from "./git-ops.js";
export {
  ALLOWED_CONFIG_KEYS,
  fingerprintChanges,
  GitConfigChangedError,
  gitConfigFingerprint,
  gitDirOf,
  globalConfigFiles,
  isAllowedConfigKey,
} from "./git-config.js";
export { gitEnv } from "./env.js";
export {
  createWorkspace,
  WORKTREES_DIR,
  WorktreeError,
  type MergeOutcome,
  type Workspace,
} from "./workspace.js";
export {
  appendRepoFile,
  assertNoSymlinks,
  ensureRepoDir,
  observeRepoWrites,
  readRepoFileCapped,
  removeRepoFile,
  UnsafePathError,
  writeRepoFile,
  type CappedRead,
  type RepoWrite,
  type RepoWriteObserver,
  type WriteRepoFileOptions,
} from "./repo-files.js";
export {
  ciFromRollup,
  createGhPullRequests,
  pullRequestFromGh,
  type PullRequestRequest,
  type PullRequestService,
} from "./pull-requests.js";
export {
  GitError,
  gitText,
  runGit,
  setGitPreflight,
  setGitSigning,
  type GitResult,
  type GitRunOptions,
} from "./exec.js";
export { HOST_CONFIG_PATHS, restoreHostConfig } from "./host-config.js";
export { createGitPlumbing, GitPlumbingRefusedError } from "./plumbing.js";
export { createRemoteRefs, type RemoteRefs } from "./remote-refs.js";
export {
  assertReplayCheckoutIntact,
  createReplayCheckout,
  exposeReplayHead,
  isReplayTree,
  newReplayTree,
  removeReplayCheckout,
  replayGitDirFingerprint,
  repoGitDirs,
  ReplayCheckoutTamperedError,
  snapshotReplayCheckout,
  type ReplayCheckout,
} from "./replay-checkout.js";
