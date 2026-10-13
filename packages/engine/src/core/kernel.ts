/**
 * The engine's internal context, shared by its modules (dispatch, submit, jobs, parking, limits).
 * Every state change goes through `emit`: append to the run's log (validated, redacted), apply to
 * the projection, notify listeners. Nothing else mutates run state (AD-7 rule 2, AD-8).
 */
import type {
  AutoResumeScheduler,
  GateRunner,
  GatesConfig,
  GitOps,
  HostAdapter,
  HostId,
  ProjectConfig,
  PullRequestService,
  UsageSnapshot,
  VtcEvent,
} from "@vtc/shared";
import type { Workspace } from "../git/index.js";
import type { DispatchRecord } from "./dispatch-record.js";
import type { EngineWrites } from "./engine-writes.js";
import type { EventDraft, EventLogWriter } from "./event-log.js";
import type { EngineLock } from "./lock.js";
import type { PluginCatalog } from "./plugins.js";
import type { RoleRegistry } from "./roles.js";
import type { RunState } from "./state.js";

export interface EngineCoreDeps {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /**
   * Absolute VTC home (`~/.vtc`): hidden tests, and the engine's private directory for this repo
   * (`guard.ts`: the write ledger, dispatch records, a held git change), which no role can write.
   */
  readonly vtcHome: string;
  /** The engine lock (AD-12): only its holder appends. */
  readonly lock: EngineLock;
  readonly gateRunner: GateRunner;
  readonly git: GitOps;
  readonly workspace: Workspace;
  readonly pullRequests: PullRequestService;
  readonly adapters: Readonly<Partial<Record<HostId, HostAdapter>>>;
  readonly autoResume: AutoResumeScheduler;
  /** The compiled role contracts (AD-14; only from the plugin assets). */
  readonly roles: RoleRegistry;
  /** What the compiled plugins hold: prompt SHAs, discipline profiles, skills (§13, §5.2a). */
  readonly plugins: PluginCatalog;
  readonly now: () => Date;
  /** Uniform [0, 1) for the auto-resume jitter (§6.9 step 4). */
  readonly random: () => number;
  /** The remote Level 2 pushes to. */
  readonly remote: string;
}

export interface RunHandle {
  readonly state: RunState;
  readonly log: EventLogWriter;
}

/**
 * Who is calling a tool: the bridge's host (AD-12 rule 3), or `null` for the cli; and, over the
 * socket, the connection's session id and client kind. A bridge session other than the run's
 * Lead session is treated as a role session (spine §7: until the Codex per-agent MCP isolation
 * spike passes, Lead-only tools are refused from role sessions).
 */
export interface CallContext {
  readonly host: HostId | null;
  readonly session?: string;
  readonly client?: "bridge" | "cli";
}

export class EngineError extends Error {
  constructor(
    readonly code:
      "no_run" | "run_active" | "invalid" | "conflict" | "config" | "finished" | "forbidden",
    message: string,
  ) {
    super(message);
    this.name = "EngineError";
  }
}

export interface Kernel {
  readonly deps: EngineCoreDeps;
  now(): Date;
  config(): ProjectConfig;
  /** The active run's frozen `gates.yml` (committed at its start commit, reading 46f). */
  gatesConfig(): GatesConfig | null;
  /**
   * SHA-256 of that file's bytes (`GateRunRequest.gates_config_hash`, reading 46b); `null` when the
   * run started with none or a restart could not recover it (`baselineGates` then checks the
   * base's committed file against the run's `pipeline_config_hash`).
   */
  gatesConfigHash(): string | null;
  /** Known secret values (the repo's `.env` values) for redaction (AD-18). */
  secrets(): readonly string[];
  /** Latest usage per host (§6.9). */
  readonly usage: Map<HostId, UsageSnapshot>;
  emit(handle: RunHandle, draft: EventDraft): VtcEvent;
  /** Starts a background job unless one with the same key runs; re-advances the run after it. */
  spawn(handle: RunHandle, key: string, job: () => Promise<void>): void;
  isRunning(key: string): boolean;
  /** True while a background job for this task or feature id runs (gates, merge, release). */
  jobRunningFor(id: string): boolean;
  /** Engine-internal transitions until nothing changes (synchronous; may start jobs). */
  advance(handle: RunHandle): void;
  /** Serialises work on one run across awaits. */
  serial<T>(handle: RunHandle, fn: () => Promise<T>): Promise<T>;
  /** The host a dispatch runs on. */
  hostFor(call: CallContext): HostId;
  /** Every run of the repo (ids are repo-wide: plan files, features). */
  allStates(): Iterable<RunState>;
  /** In-memory per-task hint: the round's head has the same tree as the previous round's. */
  readonly identicalTree: Map<string, boolean>;
  /** The engine's private directory for this repo (`guard.ts`). */
  readonly guardDir: string;
  /** Every dispatch's record, by `recordKey(run, action)` (AD-7 rule 7, `dispatch-guard.ts`). */
  readonly dispatches: Map<string, DispatchRecord>;
  /** What the engine wrote in the repo, to tell its own writes from anyone else's (AD-7 rule 7). */
  readonly writes: EngineWrites;
  /** The git fingerprint engine git must match after a reported change, until the human resumes. */
  gitHold: Readonly<Record<string, string>> | null;
  /**
   * The git fingerprint at the start of each gate run still running, by its record's id
   * (`guardGateRun`; each is also kept in the guard directory until it is checked).
   */
  readonly gateBaselines: Map<string, Readonly<Record<string, string>>>;
}
