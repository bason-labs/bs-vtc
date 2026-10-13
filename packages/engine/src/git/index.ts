/**
 * Git, worktrees and clean verification checkouts (AD-13 rule 4; owner: engine-core team,
 * sub-project 1). Implements the frozen `GitOps` seam from @vtc/shared (`createGitOps`), which the
 * cli builds and injects into the Gate Runner (`GateRunnerDeps.git`); engine core also uses it for
 * worktrees, the submit snapshot commit (`role.submitted.head`) and the merge queue. Imports no
 * other engine module. Uses the user's own git auth (AD-9). Also home of the engine's repo file
 * writes that never follow a symlink (`writeRepoFile`, `appendRepoFile`).
 */
export { createGitOps, parseNameStatus, CHECKOUTS_DIR } from "./git-ops.js";
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
  UnsafePathError,
  writeRepoFile,
} from "./repo-files.js";
export {
  ciFromRollup,
  createGhPullRequests,
  pullRequestFromGh,
  type PullRequestRequest,
  type PullRequestService,
} from "./pull-requests.js";
export { GitError, gitText, runGit, type GitResult, type GitRunOptions } from "./exec.js";
