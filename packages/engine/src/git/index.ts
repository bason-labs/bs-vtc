/**
 * Git, worktrees and clean verification checkouts (AD-13 rule 4; owner: engine-core team,
 * sub-project 1). Implements the frozen `GitOps` seam from @vtc/shared (`createGitOps`), which the
 * cli builds and injects into the Gate Runner (`GateRunnerDeps.git`); engine core also uses it for
 * worktrees, the submit snapshot commit (`role.submitted.head`) and the merge queue. Imports no
 * other engine module. Uses the user's own git auth (AD-9).
 */
import type { CreateGitOps } from "@vtc/shared";

export const createGitOps: CreateGitOps = () => {
  throw new Error("createGitOps is not implemented yet (engine core, sub-project 1)");
};
