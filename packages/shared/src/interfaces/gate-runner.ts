/**
 * Gate Runner seam (AD-13). Implemented by the engine's `gates/` module (sub-project 2) and
 * called by engine core only through this interface, so the two teams share no internals.
 */
import type { GateReport, GateRunRequest, WriteScopeReport } from "../gate-result.js";
import type { Glob, GitSha, RelPath, Sha256Hex } from "../primitives.js";
import type { GitOps } from "./git.js";

/**
 * The check runs on commits, never on an uncommitted worktree: on submit, engine core commits the
 * worktree onto the task branch (`role.submitted.head`) and asks for `base..head`.
 */
export interface WriteScopeCheckRequest {
  /** Repo-relative worktree of the task (under `.vtc/state/`). */
  readonly worktree: RelPath;
  readonly base: GitSha;
  /** The submit snapshot commit (`role.submitted.head`). */
  readonly head: GitSha;
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

/** What the Gate Runner needs, injected by the cli (AD-19). */
export interface GateRunnerDeps {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /**
   * Absolute VTC home: pinned scanner store, hidden tests (`HIDDEN_TESTS`), the gate allowlist
   * (`gateAllowlistFile`).
   */
  readonly vtcHome: string;
  /** Diffs, base-commit file reads and clean checkouts (AD-13 rule 4), built by `git.createGitOps`. */
  readonly git: GitOps;
  readonly now?: () => Date;
}

/** Implemented by the gate-runner team in `@vtc/engine` (`gates.createGateRunner`). */
export type CreateGateRunner = (deps: GateRunnerDeps) => GateRunner;
