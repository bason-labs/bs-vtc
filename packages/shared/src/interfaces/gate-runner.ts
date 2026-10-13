/**
 * Gate Runner seam (AD-13). Implemented by the engine's `gates/` module (sub-project 2) and
 * called by engine core only through this interface, so the two teams share no internals.
 */
import type {
  GateReport,
  GateRunRequest,
  GateSandboxKind,
  WriteScopeReport,
} from "../gate-result.js";
import type { GatePhase } from "../gates-config.js";
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

/** Where one wrapped gate command may write and what it may not read (D-al, `GATE_SANDBOX`). */
export interface GateSandboxSpec {
  /** §7.2 phase: `verify` gets no network; `install` gets registries only, or the full network. */
  readonly phase: GatePhase;
  /** Absolute verification checkout: the command's working directory, writable. */
  readonly checkout: string;
  /** Absolute private temp directory of this command, writable (`TMPDIR` points here). */
  readonly tempDir: string;
  /** Absolute empty per-run home (`HOME` points here). */
  readonly home: string;
  /**
   * Absolute paths the command may not read: the VTC home and the host config and credential
   * locations (`hostCredentialDenyReadPaths` and the host config directories). Never opened.
   */
  readonly denyRead: readonly string[];
}

/** The argv to spawn instead of the gate's own, and the network it really gets. */
export interface WrappedGateCommand {
  readonly command: string;
  readonly args: readonly string[];
  /** `registries` only where the sandbox can filter by registry; `none` in the verify phase. */
  readonly network: "none" | "registries" | "full";
}

/**
 * The OS sandbox gate commands run in (D-al, spine §5 reading 69). The Gate Runner implements
 * `sandbox-exec` (macOS, a VTC-generated profile) and `bwrap` (Linux, with a network namespace)
 * and detects which one the machine has; tests inject a fake wrapper. `kind: "none"` returns the
 * argv unchanged and is used only when {@link GateRunnerDeps.allowUnsandboxed} is true.
 */
export interface GateSandbox {
  readonly kind: GateSandboxKind;
  wrap(argv: readonly string[], spec: GateSandboxSpec): WrappedGateCommand;
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
  /**
   * The gate sandbox (D-al). Absent: the Gate Runner detects the machine's own (`sandbox-exec`
   * or `bwrap`). When there is none, gates do not run (`GATE_SANDBOX.noSandboxReason`) unless
   * `allowUnsandboxed` is true.
   */
  readonly sandbox?: GateSandbox;
  /**
   * `~/.vtc/config.yaml` `gates.allow_unsandboxed` (`UserConfigSchema`), read by the cli; never
   * from `project.yaml`. Default false. When it lets a gate run unconfined, the report says
   * `sandbox: "none"` and engine core records an `unsandboxed_gate` incident.
   */
  readonly allowUnsandboxed?: boolean;
  readonly now?: () => Date;
}

/** Implemented by the gate-runner team in `@vtc/engine` (`gates.createGateRunner`). */
export type CreateGateRunner = (deps: GateRunnerDeps) => GateRunner;
