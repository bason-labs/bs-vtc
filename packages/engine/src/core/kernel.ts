/**
 * The engine's internal context, shared by its modules (dispatch, submit, jobs, parking, limits).
 * Every state change goes through `emit`: append to the run's log (validated, redacted), apply to
 * the projection, notify listeners. Nothing else mutates run state (AD-7 rule 2, AD-8).
 */
import type {
  ArmPluginCompiler,
  AutoResumeScheduler,
  GateRunner,
  GateRunRequest,
  GateVerdict,
  GatesConfig,
  GitOps,
  HeadlessRun,
  HeadlessRunSummary,
  HostAdapter,
  HostBilling,
  HostId,
  ModelPrice,
  ProjectConfig,
  PromptVersionRef,
  PullRequestService,
  RemoteMergeService,
  ReplayInfraOutcome,
  RoleMcpToolName,
  RoleResult,
  SessionSandboxState,
  TaskPack,
  TaskRiskClass,
  TaskSize,
  UnverifiedFactSummary,
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
import type { TierRoute } from "./routing.js";
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
  /**
   * The user's price table (`~/.vtc/config.yaml` `prices`, §11; spine §5 reading 152): the engine
   * prices a run's tokens from it when the host reported no cost, and an engine-launched run on a
   * host that cannot cap its own spend (Codex) starts only when its model is priced here.
   */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
  /**
   * Replay arm plugins (`EngineDeps.armPlugins`, D-cg, spine §5 reading 201): on a host whose
   * headless runs load the compiled agent (Claude Code) each replay arm runs its own compiled
   * plugin. Absent: such a host's replays cannot run a candidate and wait for the next RETRO.
   */
  readonly armPlugins?: ArmPluginCompiler;
}

/** One engine-launched headless role run in flight (AD-25; `StatusResult.headless_runs`). */
export interface HeadlessEntry {
  readonly run: string;
  readonly summary: HeadlessRunSummary;
  readonly process: HeadlessRun;
  /** Set when `vtc pause` killed it: its end is then not the role's failure. */
  stoppedByPause?: boolean;
  /**
   * Set when the engine killed it because its task parked on budget (§11): its end is a stop
   * with cause `budget`, not the role's failure.
   */
  stoppedByBudget?: boolean;
  /**
   * The budget pool it was capped from (`task:<id>` or `run`, §11) and the cap in USD: what the
   * next launch from the same pool may not hand out again while this run is in flight.
   */
  readonly budget?: { readonly pool: string; readonly capUsd: number };
  /**
   * A replay trial's own compiled arm plugin (`SpawnRoleRequest.pluginDir`, D-cg): after the run
   * the adapter must prove this copy loaded (`HeadlessRun.pluginLoad`), and it is removed.
   */
  readonly pluginDir?: string;
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
 * research (AD-13 rule 12). It may return the table's facts G2 blocks on, each re-checked against
 * the research cache: the table is git-tracked, so G2 then trusts no status a row records (spine
 * §5 reading 120). `null`: core reads the statuses the rows record.
 */
export type FactRefresher = (repoRoot: string) => Promise<readonly UnverifiedFactSummary[] | null>;

/** The dispatch a prompt version is selected for (AD-21). */
export interface PromptTarget {
  readonly run: string;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  /** The compiled agent that runs it (a discipline profile for an Engineer task, §5.2a). */
  readonly agent: string;
  readonly task?: string;
}

/** The editable section a dispatch carries, and the prompt version it makes (AD-21 rule 1). */
export interface PinnedPrompt {
  /** `effective_sha256` becomes the envelope's `prompt_sha`, `editable_sha256` the event's. */
  readonly version: PromptVersionRef;
  /** The editable section, rendered first in the task pack (AD-21 rule 2, reading 102). */
  readonly text: string;
  /** The canary arm the dispatch runs in, when a canary covers the role (AD-21 rule 7). */
  readonly canary?: {
    readonly arm: "candidate" | "baseline";
    readonly candidate: string;
    readonly baseline: string;
  };
}

/**
 * Selects the pinned editable section for a dispatch, or `null` for the compiled agent's own
 * (AD-21 rules 1–3 and 7: user-level pins and canaries, never repo content). The lookback module
 * implements it and the daemon hands it to the engine (`Engine.setPromptPins`), so core never
 * imports lookback (AD-13 rule 12). Synchronous: it reads its pins once and caches them.
 */
export type PromptPins = (target: PromptTarget) => PinnedPrompt | null;

/** A (role, host) prompt version the lookback role proposes for (AD-21 rule 8). */
export interface LookbackTargetRef {
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
}

/** One target the RETRO step queues the lookback role for, with what that role reads. */
export interface LookbackRetroTarget extends LookbackTargetRef {
  /** Its `lookback.dispatched` (attributed train failures of the version under review). */
  readonly dispatched: EventDraft;
  /**
   * The Markdown the lookback role reads (`.vtc/runs/<run>/lookback-<n>.md`): the version under
   * review with its locked core and editable section, its train traces and the human edits.
   */
  readonly input: string;
}

/**
 * One `lookback_replay` trial (AD-21 rule 6, spine §5 reading 176): a recorded dispatch run again,
 * in a clean checkout at the commit it started from, with one arm's prompt version.
 */
export interface LookbackReplayTrial {
  /** `a` the baseline, `b` the candidate, `aa` the baseline's second arm (the A/A noise floor). */
  readonly arm: "a" | "b" | "aa";
  /** 1-based. */
  readonly trial: number;
  /** The replayed task, the replay result's `per_task` key (`<run>:<task>`). */
  readonly task: string;
  /** The task passed with the baseline (a regression-set task). */
  readonly regressionSet: boolean;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  /** The arm's prompt version and its editable section (rendered first in the pack). */
  readonly prompt: PinnedPrompt;
  /** The recorded dispatch's task pack: what the trial reads (its inputs, scope and subject). */
  readonly pack: TaskPack;
  /** The commit the recorded dispatch started from (the trial's checkout is at it). */
  readonly base: string;
  /**
   * The recorded task's QA-owned acceptance tests (repo-relative): protected by checksum at
   * `base` when the trial is graded, as in the recorded round (§7.3), and kept out of the trial's
   * sandbox writes. Absent: none.
   */
  readonly protectedPaths?: readonly string[];
  /**
   * The tier the recorded dispatch ran on and why (`role.dispatched.tier`, H-9, D-cm): the trial
   * runs on it, so an arm measures a prompt, not a tier (spine §5 reading 218 (7)). Absent (a
   * dispatch logged before 5.4.0): the role's own tier.
   */
  readonly tier?: TierRoute;
}

/** The replay of one proposal: its trials, run one at a time in order. */
export interface LookbackReplay {
  readonly proposal: string;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  readonly trials: readonly LookbackReplayTrial[];
}

/**
 * What one replay trial came to, for Lookback's trial ledger (D-cg, spine §5 reading 201): a grade
 * (`passed`, the tokens it used, whether the host enforced its read deny), or an attempt that
 * measured nothing for an infrastructure reason the ledger counts (`ReplayInfraOutcome`). A trial
 * that measured nothing for another reason (the engine stopped, its run was interrupted or
 * refused) is not recorded: it is simply planned again.
 */
export type ReplayTrialRecord =
  | {
      readonly kind: "graded";
      readonly passed: boolean;
      readonly tokens: number;
      readonly readDenied: boolean;
    }
  | {
      readonly kind: "unmeasured";
      readonly outcome: ReplayInfraOutcome;
    };

/** A graded trial: its index in `LookbackReplay.trials`, whether it passed, the tokens it used. */
export interface ReplayTrialOutcome {
  readonly n: number;
  readonly passed: boolean;
  readonly tokens: number;
  /**
   * The host enforced the trial's `SandboxProfileRequest.readDeny` on the user's repo
   * (`SandboxProfile.enforced.readDeny`, spine §5 reading 178): the replay's `isolation` is
   * `read_denied` only when every trial was. Absent: not enforced.
   */
  readonly readDenied?: boolean;
}

/**
 * One routing-table cell Lookback proposes to change (D-cn, spine §5 reading 219): the cell
 * (role, size, risk class), the scorecard numbers that support it, and the engine's own text (it
 * stays local). The upstream module fingerprints it by its subject.
 */
export interface RoutingProposalCell {
  readonly role: string;
  readonly size: TaskSize;
  readonly risk: TaskRiskClass;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly detail: string;
}

/**
 * Lookback's routing step at RETRO (D-cn): write the routing scorecard
 * (`.vtc/lookback/scorecards/routing.json`, `RoutingScorecard`) from the history and return the
 * cells whose start tier it proposes to change. The lookback module implements it (the
 * lookback-research team's routing scorecard writer and routing proposals, `lookback/`, which names
 * this type from core's index); the daemon calls it at RETRO, beside the `LookbackRetro` seam it
 * hands core. Core itself never calls it.
 */
export type RoutingLookback = (input: {
  readonly projectRoot: string;
  /** Every run's events as Lookback reads them (without replay trials, reading 177). */
  readonly history: readonly VtcEvent[];
  readonly graderBundleSha: string;
  readonly now: Date;
  /**
   * The locked prompt section of each dispatch's version, with which Lookback trusts the rows of
   * `attributions.jsonl` (a failed dispatch counts against its tier's `tokens_per_success`).
   */
  readonly lockedShaFor: (
    role: string,
    mode: string | undefined,
    host: HostId,
  ) => string | undefined;
  /** The VTC home whose recorded AI tiebreaks let an `ai_tiebreak` attribution count. */
  readonly vtcHome: string;
}) => Promise<readonly RoutingProposalCell[]>;

/** An `automation.skipped` draft, the only event `LookbackRetro.replays` may hand core to log. */
export type LookbackSkippedDraft = EventDraft & { readonly type: "automation.skipped" };

/**
 * Lookback at RETRO (spec §13 steps 1–2; AD-21 rules 4 and 8; spine §5 reading 154): the lookback
 * module implements it and the daemon hands it to the engine (`Engine.setLookbackRetro`), so core
 * never imports lookback (AD-13 rule 12).
 * - `plan`: before the run finishes, attribute its failures, rewrite the scorecards and say which
 *   (role, host) targets get the lookback role (at least `minTrainFailures` train failures, the
 *   weekly window and budget allowing).
 * - `check`: the proposal the lookback role wrote for `target` in its worktree (`root`): refused
 *   with its problems (the role is told, as for any rejected result), or accepted, stored as an
 *   immutable candidate version under the VTC home, with its events
 *   (`lookback.proposal_recorded`). A role that found no cause the prompt can fix writes no
 *   proposal: accepted with no events.
 */
export interface LookbackRetro {
  /**
   * `events`: what the run logs before its targets are queued (`lookback.unattributed`, the
   * failures the attribution tree left inconclusive; spine §5 reading 182). Core logs each type
   * once per run, so a plan made again after a restart adds none.
   */
  plan(state: RunState): Promise<{
    readonly targets: readonly LookbackRetroTarget[];
    readonly events?: readonly EventDraft[];
  }>;
  /**
   * The replays RETRO runs once every lookback target is settled (AD-21 rule 6, spine §5 reading
   * 176): one per proposal recorded and not yet replayed, each with the `lookback_replay` trials
   * this RETRO launches, in order. Lookback decides which (`planRetroReplays`: the grader, the
   * weekly window, the budget and `LOOKBACK_LIMITS.maxTrialsPerRetro`, the trials its ledger
   * already graded left out), so a replay may come with only some of its trials, or none when
   * every trial is graded and it is ready to finish; core applies no trial cap of its own.
   * `wait` says why some cannot start now; `events` are Lookback's `automation.skipped` drafts
   * for the limits it hit (D-cg), which the run logs; core logs no other type through this seam
   * (AD-8: the engine decides every state transition) and drops one with a notice. Absent: no
   * replays.
   */
  replays?(state: RunState): Promise<{
    readonly replays: readonly LookbackReplay[];
    readonly wait?: string;
    /** The limit `wait` names, for its `automation.skipped` (D-cg); absent: no limit. */
    readonly waitKind?: "weekly_window" | "budget";
    readonly events?: readonly LookbackSkippedDraft[];
  }>;
  /**
   * Keeps one trial's outcome in Lookback's trial ledger as it is known (D-cg, spine §5 reading
   * 201), so a replay continues across RETROs and a trial that keeps measuring nothing stops its
   * replay. Absent: no ledger.
   */
  recordTrial?(
    replay: LookbackReplay,
    trial: LookbackReplayTrial,
    record: ReplayTrialRecord,
    state: RunState,
  ): Promise<void>;
  /**
   * The same weekly-window and budget checks, again before each trial (AD-21 rule 8): why the
   * replays must stop now, or `null`. Replays that stop wait for the next RETRO.
   */
  replayWait?(state: RunState): string | null;
  /**
   * Grades one trial through the Gate Runner: the gate run's verdict. `pass` and `fail` measure the
   * trial; `infra_error` measures nothing (the trial is not counted, and its replay waits).
   */
  gradeTrial?(request: GateRunRequest): Promise<GateVerdict>;
  /**
   * The verdict grader (D-ch, spine §5 reading 202): scores a verdict role's trial (a role that
   * changes no file, `replayGraderFor` = `verdict`) by its result against the recorded outcome of
   * the replayed dispatch (`trial.task`, `<run>:<task>`): the human's G-gate or PR verdict, the gate
   * result, a later escaped defect. `pass` and `fail` measure the trial; `infra_error` measures
   * nothing. Absent: verdict roles are not replayed.
   */
  gradeVerdict?(
    trial: LookbackReplayTrial,
    result: RoleResult,
    state: RunState,
  ): Promise<GateVerdict>;
  /**
   * Called once every trial this RETRO launched for the replay is graded: the replay's result once
   * its ledger holds every trial of its plan (`assembleReplay`, `writeReplayResult`), with its
   * events (`lookback.replay_finished` with the SHA-256 of the bytes written); no events while
   * trials are still missing (they run at a later RETRO).
   */
  finishReplay?(
    replay: LookbackReplay,
    outcomes: readonly ReplayTrialOutcome[],
    state: RunState,
  ): Promise<readonly EventDraft[]>;
  check(
    target: LookbackTargetRef,
    root: string,
    state: RunState,
  ): Promise<
    | { readonly ok: true; readonly events: readonly EventDraft[] }
    | { readonly ok: false; readonly problems: readonly string[] }
  >;
}

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
  /**
   * The facts-table entries G2 blocks on as the wired research module last re-checked them
   * (`FactRefresher`), or `null` when none is wired or it has not run since the engine started
   * (G2 then reads the statuses `facts.jsonl` records).
   */
  factTable?(): readonly UnverifiedFactSummary[] | null;
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
   * Who pays for `host`'s role runs, from its last sign-in check (`HostAuthStatus.billing`; `null`
   * when the check does not say): kept on the host's usage snapshot (`UsageSnapshot.billing`), so
   * `GET /api/usage` carries it and Flow Studio shows `API_KEY_BILLING_WARNING` (D-bq, spine §5
   * reading 171).
   */
  recordBilling(host: HostId, billing: HostBilling | null): void;
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
  /** The prompt-version selector the daemon wired (`Engine.setPromptPins`), or `null`. */
  promptPins(): PromptPins | null;
  /** Lookback at RETRO as the daemon wired it (`Engine.setLookbackRetro`), or `null`. */
  lookbackRetro(): LookbackRetro | null;
  /** A notice for the human (the daemon prints them): what went wrong that is no run's failure. */
  notice(text: string): void;
  /**
   * A notice the run's Lead relays to the human once (`NextResult.notices`, contracts 5.0.0): a
   * run notice such as `HOST_WEB_OFF_NOTICE`, or (no `run`) one for whichever run's Lead asks next,
   * such as the automation daily summary. The same text is queued once per run.
   */
  relay(run: string | undefined, text: string): void;
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
