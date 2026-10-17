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
import type { Glob, GitSha, RelPath, Sha256Hex, Slug } from "../primitives.js";
import type { ResearchScope } from "../research.js";
import type { DesignLibraryEntry, NoveltyReport } from "../visual.js";
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
  /**
   * The novelty check of one G2 direction (§9.1 step 4, AD-24 rule 8; spine §5 reading 127): a
   * perceptual hash of its first viewport and the project's token vector against the design
   * library of `scope`. Engine core calls it before G2 shows and writes the report to
   * `noveltyReportPath(direction)`. Optional: without it every direction stays `unchecked`.
   * New in 4.6.0.
   */
  checkNovelty?(request: NoveltyCheckRequest): Promise<NoveltyReport>;
  /**
   * Adds the direction a human chose at G2 to the design library of `scope` (§9.1 step 6).
   * Optional, like {@link GateRunner.checkNovelty}. New in 4.6.0.
   */
  recordDesignChoice?(entry: DesignLibraryEntry, scope: ResearchScope): Promise<void>;
}

/** What {@link GateRunner.checkNovelty} compares. New in 4.6.0. */
export interface NoveltyCheckRequest {
  readonly direction: Slug;
  /** Repo-relative PNG of the direction's first viewport (`G2Direction.first_viewport`). */
  readonly firstViewport: RelPath;
  /** The design library's scope: `researchScopeFor(project.yaml client)`; no lookup crosses it. */
  readonly scope: ResearchScope;
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
  /**
   * Verify phase only (D-av, spine §5 reading 84): the test suite may open sockets to the
   * loopback (127.0.0.1 / ::1) and nothing else, as `.vtc/gates.yml` `sandbox.verify_loopback`
   * records after the human said so at `vtc calibrate`'s confirmation. The macOS profile honours
   * it; on Linux bwrap's private network namespace already has a loopback of its own. The install
   * phase never reaches the host loopback. New in contracts 4.4.0.
   */
  readonly loopback?: boolean;
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
  /**
   * `~/.vtc/config.yaml` `gates.allow_tools_hashed_after_scripts` (`UserConfigSchema`, H-14,
   * spine §5 reading 250), read by the cli. No effect since 5.10.0 (spine §5 reading 251): a
   * verify gate whose tools were hashed only after an install gate ran its lifecycle scripts
   * runs, its `ToolIntegrity.baseline` `after_scripts` and a warning in its evidence, and the
   * workspace-wide comparison still covers every change after the hash. Kept so callers that
   * pass it still compile.
   */
  readonly allowToolsHashedAfterScripts?: boolean;
  readonly now?: () => Date;
}

/** Implemented by the gate-runner team in `@vtc/engine` (`gates.createGateRunner`). */
export type CreateGateRunner = (deps: GateRunnerDeps) => GateRunner;
