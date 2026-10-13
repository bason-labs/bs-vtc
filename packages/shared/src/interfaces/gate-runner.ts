/**
 * Gate Runner seam (AD-13). Implemented by the engine's `gates/` module (sub-project 2) and
 * called by engine core only through this interface, so the two teams share no internals.
 */
import type { GateReport, GateRunRequest, WriteScopeReport } from "../gate-result.js";
import type { Glob, GitSha, RelPath, Sha256Hex } from "../primitives.js";

export interface WriteScopeCheckRequest {
  /** Repo-relative worktree of the task (under `.vtc/state/`). */
  readonly worktree: RelPath;
  readonly base: GitSha;
  readonly filesScope: readonly Glob[];
  /** Protected files and the checksums they must still have (§7.3). */
  readonly protected: readonly { readonly path: RelPath; readonly sha256: Sha256Hex }[];
}

export interface GateRunner {
  /**
   * Runs the configured layers on a clean verification checkout (§6.3 step 5, §7.2) and returns
   * one report. Never throws for a failing gate: failures, infra errors and timeouts are results.
   */
  run(request: GateRunRequest): Promise<GateReport>;
  /**
   * L5 write-scope and test-integrity check of a worktree diff. Engine core calls it on every
   * `submit` (§4.2 step 3, §6.3 step 4); `run` includes it as layer L5.
   */
  checkWriteScope(request: WriteScopeCheckRequest): Promise<WriteScopeReport>;
}
