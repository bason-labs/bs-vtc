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
  UsageSnapshot,
  VtcEvent,
} from "@vtc/shared";
import type { PullRequestService, Workspace } from "../git/index.js";
import type { EventDraft, EventLogWriter } from "./event-log.js";
import type { EngineLock } from "./lock.js";
import type { RoleRegistry } from "./roles.js";
import type { RunState } from "./state.js";

export interface EngineCoreDeps {
  /** Absolute repo root. */
  readonly repoRoot: string;
  /** Absolute VTC home (`~/.vtc`): hidden tests. */
  readonly vtcHome: string;
  /** The engine lock (AD-12): only its holder appends. */
  readonly lock: EngineLock;
  readonly gateRunner: GateRunner;
  readonly git: GitOps;
  readonly workspace: Workspace;
  readonly pullRequests: PullRequestService;
  readonly adapters: Readonly<Partial<Record<HostId, HostAdapter>>>;
  readonly autoResume: AutoResumeScheduler;
  readonly roles: RoleRegistry;
  readonly now: () => Date;
  /** Uniform [0, 1) for the auto-resume jitter (§6.9 step 4). */
  readonly random: () => number;
  /** Content SHA of the compiled agent prompt a dispatch uses (§13 prompt versions). */
  readonly promptSha: (agent: string, host: HostId) => string;
  /** The remote Level 2 pushes to. */
  readonly remote: string;
}

export interface RunHandle {
  readonly state: RunState;
  readonly log: EventLogWriter;
}

/** Who is calling a tool: the bridge's host (AD-12 rule 3), or `null` for the cli. */
export interface CallContext {
  readonly host: HostId | null;
}

export class EngineError extends Error {
  constructor(
    readonly code: "no_run" | "run_active" | "invalid" | "conflict" | "config" | "finished",
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
  gatesConfig(): GatesConfig | null;
  /** Known secret values (the repo's `.env` values) for redaction (AD-18). */
  secrets(): readonly string[];
  /** Latest usage per host (§6.9). */
  readonly usage: Map<HostId, UsageSnapshot>;
  emit(handle: RunHandle, draft: EventDraft): VtcEvent;
  /** Starts a background job unless one with the same key runs; re-advances the run after it. */
  spawn(handle: RunHandle, key: string, job: () => Promise<void>): void;
  isRunning(key: string): boolean;
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
}
