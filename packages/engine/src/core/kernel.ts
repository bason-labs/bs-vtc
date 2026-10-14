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
  HeadlessRun,
  HeadlessRunSummary,
  HostAdapter,
  HostId,
  ProjectConfig,
  PullRequestService,
  RemoteMergeService,
  RoleMcpToolName,
  SessionSandboxState,
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
  /**
   * Level-3 auto-merge and the post-merge watch (AD-23, `EngineDeps.remoteMerge`). Absent: Level 3
   * is unavailable and a run configured for it starts at Level 2 (`merge.preflight`).
   */
  readonly remoteMerge?: RemoteMergeService;
  readonly adapters: Readonly<Partial<Record<HostId, HostAdapter>>>;
  readonly autoResume: AutoResumeScheduler;
  /** The compiled role contracts (AD-14; only from the plugin assets). */
  readonly roles: RoleRegistry;
  /** What the compiled plugins hold: prompt SHAs, discipline profiles, skills (§13, §5.2a). */
  readonly plugins: PluginCatalog;
  readonly now: () => Date;
  /** Waits between polls of the remote (Level 3); tests inject one that moves their clock. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Uniform [0, 1) for the auto-resume jitter (§6.9 step 4). */
  readonly random: () => number;
  /** The remote Level 2 pushes to. */
  readonly remote: string;
  /**
   * The platform roles run on (default `process.platform`): Codex roles run in-session only where
   * Codex's network-off sandbox is shown to block a Unix-socket connect (spine §5 reading 79).
   */
  readonly platform?: NodeJS.Platform;
}

/** One engine-launched headless role run in flight (AD-25; `StatusResult.headless_runs`). */
export interface HeadlessEntry {
  readonly run: string;
  readonly summary: HeadlessRunSummary;
  readonly process: HeadlessRun;
}

/**
 * Runs one role-facing MCP tool (`ROLE_MCP_TOOLS`: research fetches and the facts table, AD-22)
 * on input that passed its contract. The research module implements it; the daemon hands it to
 * the engine (`Engine.setRoleTools`), so core never imports research (AD-13 rule 12).
 */
export type RoleToolHandler = (
  name: RoleMcpToolName,
  input: unknown,
  call: CallContext,
) => Promise<unknown>;

/**
 * Re-fetches the facts table's stale facts (AD-22 rule 4: "before G2 the engine re-fetches stale
 * facts"); it appends the new rows to `.vtc/research/facts.jsonl`. The research module implements
 * it and the daemon hands it to the engine (`Engine.setFactRefresher`), so core never imports
 * research (AD-13 rule 12).
 */
export type FactRefresher = (repoRoot: string) => Promise<void>;

export interface RunHandle {
  readonly state: RunState;
  readonly log: EventLogWriter;
}

/**
 * Who is calling a tool: the bridge's host (AD-12 rule 3), or `null` for the cli; and, over the
 * socket, the connection's session id and client kind. A bridge session other than the run's
 * Lead session is treated as a role session (spine §7: until the Codex per-agent MCP isolation
 * spike passes, Lead-only tools are refused from role sessions). No `client` means an in-process
 * caller (the composition and tests), never a socket connection.
 */
export interface CallContext {
  readonly host: HostId | null;
  readonly session?: string;
  readonly client?: "bridge" | "cli";
  /**
   * A cli connection whose `EngineSocketHello.install_token` matched the daemon's (compared in
   * constant time): a human channel for the human-only tools (D-an, spine §5 reading 71). Only
   * the socket sets it; a bare `{client: "cli"}` hello never does.
   */
  readonly human?: boolean;
  /**
   * What the caller's host session reported about its OS sandbox (`EngineSocketHello
   * .session_sandbox`, bridge only; absent = unknown). The engine keeps the run's Lead session's
   * report to decide in-session dispatch of code-running roles (D-an, `inSessionDispatchAllowed`).
   */
  readonly sessionSandbox?: SessionSandboxState;
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
  /** Task ids git showed taken by another clone when the plan was made (spine §5 reading 89). */
  readonly sharedTaskIds: Set<string>;
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
  /** Stores a usage reading (statusline, adapter, an engine-launched run's stream; §6.9). */
  ingestUsage(snapshot: UsageSnapshot): void;
  /**
   * `pipelineConfigHash` of `project.yaml` and `gates.yml` as they are on disk now, or `null`
   * when they do not parse (the headless preflight's `config` check, AD-25 rule 3).
   */
  diskConfigHash(): string | null;
  /**
   * The host of the run's Lead session (AD-17 rule 5, `planDispatch`'s `leadHost`): the host the
   * Lead's bridge declared in its hello, or an in-process caller's own host; `undefined` when no
   * session holds the run's Lead and the caller cannot (a cli connection, a role session).
   */
  leadHostFor(run: string, call: CallContext): HostId | undefined;
  /** The host of the bridge session holding `run`'s Lead, or `undefined` when none does. */
  liveLeadHost(run: string): HostId | undefined;
  /**
   * Runs the auto-resume timer resumed with no live Lead (§6.9 step 6, AD-17 rule 2): while one
   * is here, the engine drives its steps itself as headless runs (`headless_allowed` only), until
   * a Lead session calls `next` again.
   */
  readonly unattended: Set<string>;
  /** Engine-launched headless runs in flight, by action id (AD-25). */
  readonly headless: Map<string, HeadlessEntry>;
  /**
   * Aborted once the engine shuts down (`Engine.shutdown`): no new job or headless run starts, and
   * long waits (the Level-3 release) stop at once.
   */
  readonly stopping: AbortSignal;
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
  /**
   * The sandbox state of the session an in-session role of `run` would run in (D-an): the run's
   * Lead session's report when the run has a Lead session; an in-process caller's own otherwise;
   * `undefined` (unknown, which refuses) for a socket caller of a run with no Lead session.
   */
  sessionSandboxFor(run: string, call: CallContext): SessionSandboxState | undefined;
  /**
   * True when no session holds `run`'s Lead and `call` is a socket caller (a cli connection, or a
   * bridge session bound to a role action), so there is no Lead session whose sandbox could
   * decide: an in-session step waits for the Lead instead of parking (`dispatchNow`).
   */
  leadless(run: string, call: CallContext): boolean;
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
