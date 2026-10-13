/**
 * The engine (§4.1, §4.2; AD-4, AD-7, AD-8): owns every run's state, rebuilt from the event logs
 * on open, and answers the Lead-facing tools. The Lead only ever dispatches what `next` returns;
 * the engine decides every transition, cap, budget and route (D11).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  dotenvValues,
  HOST_IDS,
  remainingPct,
  type ApproveInput,
  type AnswerInput,
  type ChangeRequestInput,
  type ChangeRequestResult,
  type EscalationList,
  type FrozenArtifact,
  type GatesConfig,
  type HostId,
  type HumanGateId,
  type LeadAction,
  type NextResult,
  type Phase,
  type ProjectConfig,
  type RunControlResult,
  type RunScopedInput,
  type StartInput,
  type StartResult,
  type StatusResult,
  type SubmitInput,
  type SubmitResult,
  type UsageSnapshot,
  type VtcEvent,
} from "@vtc/shared";
import {
  ConfigError,
  GATES_CONFIG_PATH,
  loadGatesConfig,
  loadProjectConfig,
  pipelineConfigHash,
  PROJECT_CONFIG_PATH,
} from "./config.js";
import { dispatchNow, phaseRoles } from "./dispatch.js";
import { parkEscalation } from "./escalations.js";
import { openEventLog, type EventDraft } from "./event-log.js";
import {
  ensureWorkspace,
  setFeatureStatus,
  startBaseCheck,
  startFinalReview,
  startMergeQueue,
  startRelease,
  startRoundGates,
} from "./jobs.js";
import {
  EngineError,
  type CallContext,
  type EngineCoreDeps,
  type Kernel,
  type RunHandle,
} from "./kernel.js";
import { limitWait, maybeAutoResume } from "./limits.js";
import { ACTIVE_TASK_STATUSES } from "./machines.js";
import { applyAnswer, setTaskStatus } from "./parking.js";
import { writePlanFile, writeRequestFile } from "./projections.js";
import {
  inFlight,
  lastBuilt,
  lastSubmitted,
  nextEscalationId,
  pendingBaseCheck,
  phaseEnteredSeq,
  roundVerdict,
} from "./queries.js";
import { loadResult } from "./results.js";
import { completedReviews, startTriage } from "./review.js";
import { activeRun } from "./read-model.js";
import { loadRuns } from "./run-store.js";
import { schedule } from "./scheduler.js";
import { applyEvent, emptyRunState, type RunState } from "./state.js";
import { handleSubmit } from "./submit.js";
import { escalationListView, openEscalations, statusView } from "./views.js";

const sha256File = (path: string): string | undefined =>
  existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined;

/** A 5-hour reading worth logging: a changed percentage, reset or source (§6.9). */
const significant = (before: UsageSnapshot | undefined, after: UsageSnapshot): boolean => {
  if (before === undefined) return true;
  const key = (s: UsageSnapshot): string =>
    JSON.stringify([
      s.source,
      s.windows.map((w) => [
        w.kind,
        w.used_pct === null ? null : Math.floor(w.used_pct),
        w.resets_at,
      ]),
      s.model_limits.map((m) => [m.model, m.resets_at]),
    ]);
  return key(before) !== key(after);
};

export type EventListener = (event: VtcEvent) => void;

export class Engine implements Kernel {
  readonly usage = new Map<HostId, UsageSnapshot>();
  readonly identicalTree = new Map<string, boolean>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly finished = new Map<string, RunState>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<EventListener>();
  private readonly fileCache = new Map<string, { stamp: number; value: unknown }>();

  private constructor(readonly deps: EngineCoreDeps) {}

  /** Opens the engine on a repo: replays every run's log (AD-7 rule 5) and recovers its work. */
  static open(deps: EngineCoreDeps): Engine {
    const engine = new Engine(deps);
    for (const loaded of loadRuns(deps.repoRoot)) {
      const state = loaded.state;
      for (const [host, snapshot] of state.usage) engine.usage.set(host, snapshot);
      if (state.run.finished_at !== undefined) {
        engine.finished.set(state.id, state);
        continue;
      }
      const log = openEventLog(deps.repoRoot, state.id, deps.lock, {
        now: deps.now,
        secrets: () => engine.secrets(),
      });
      const handle: RunHandle = { state, log };
      engine.handles.set(state.id, handle);
      const damaged = log.recovered.invalidLines.length > 0 || log.recovered.truncatedTail;
      const reported = state.events.some(
        (e) =>
          e.type === "incident.recorded" &&
          (e.data as { kind?: string }).kind === "log_corruption" &&
          JSON.stringify((e.data as { invalid_lines?: number[] }).invalid_lines ?? []) ===
            JSON.stringify(log.recovered.invalidLines),
      );
      if (damaged && !reported) {
        engine.emit(handle, {
          type: "incident.recorded",
          actor: "engine",
          data: {
            kind: "log_corruption",
            detail: log.recovered.truncatedTail
              ? "the log ended in a torn line (an unclean stop); it was fenced off"
              : "the log has lines that do not parse",
            invalid_lines: [...log.recovered.invalidLines],
          },
        });
      }
    }
    for (const handle of engine.handles.values()) engine.advance(handle);
    return engine;
  }

  // ------------------------------------------------------------------ kernel

  now(): Date {
    return this.deps.now();
  }

  /** Reads a repo file through a cache keyed on its modification time (files may change). */
  private cached<T>(path: string, load: () => T): T {
    const abs = join(this.deps.repoRoot, path);
    const stamp = existsSync(abs) ? statSync(abs).mtimeMs : -1;
    const hit = this.fileCache.get(path);
    if (hit !== undefined && hit.stamp === stamp) return hit.value as T;
    const value = load();
    this.fileCache.set(path, { stamp, value });
    return value;
  }

  config(): ProjectConfig {
    try {
      return this.cached(PROJECT_CONFIG_PATH, () => loadProjectConfig(this.deps.repoRoot));
    } catch (error) {
      if (error instanceof ConfigError) throw new EngineError("config", error.message);
      throw error;
    }
  }

  gatesConfig(): GatesConfig | null {
    try {
      return this.cached(GATES_CONFIG_PATH, () => loadGatesConfig(this.deps.repoRoot));
    } catch (error) {
      if (error instanceof ConfigError) throw new EngineError("config", error.message);
      throw error;
    }
  }

  secrets(): readonly string[] {
    return this.cached(".env", () => {
      const env = join(this.deps.repoRoot, ".env");
      return existsSync(env) ? dotenvValues(readFileSync(env, "utf8")) : [];
    });
  }

  emit(handle: RunHandle, draft: EventDraft): VtcEvent {
    const event = handle.log.append(draft);
    applyEvent(handle.state, event);
    if (event.type === "run.started")
      writeRequestFile(this.deps.repoRoot, handle.state, this.secrets());
    if (event.task !== undefined && handle.state.tasks.has(event.task)) {
      writePlanFile(this.deps.repoRoot, handle.state, event.task, this.secrets());
    }
    if (event.type === "run.finished") {
      this.handles.delete(handle.state.id);
      this.finished.set(handle.state.id, handle.state);
    }
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken listener (an SSE client gone) never breaks the engine
      }
    }
    return event;
  }

  spawn(handle: RunHandle, key: string, job: () => Promise<void>): void {
    if (this.jobs.has(key)) return;
    const promise = (async () => {
      try {
        await job();
      } catch (error) {
        if (!this.deps.lock.isHeld()) return; // another engine took over: this one stops (AD-12)
        await this.serial(handle, () => {
          this.emit(handle, {
            type: "incident.recorded",
            actor: "engine",
            data: {
              kind: "crash",
              detail:
                `background job ${key} failed: ${error instanceof Error ? error.message : String(error)}`.slice(
                  0,
                  2000,
                ),
            },
          });
          return Promise.resolve();
        });
      } finally {
        this.jobs.delete(key);
      }
      if (this.handles.has(handle.state.id) && this.deps.lock.isHeld()) {
        await this.serial(handle, () => {
          this.advance(handle);
          return Promise.resolve();
        });
      }
    })().catch(() => undefined);
    this.jobs.set(key, promise);
  }

  isRunning(key: string): boolean {
    return this.jobs.has(key);
  }

  serial<T>(handle: RunHandle, fn: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(handle.state.id) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    this.chains.set(
      handle.state.id,
      next.catch(() => undefined),
    );
    return next;
  }

  hostFor(call: CallContext): HostId {
    if (call.host !== null) return call.host;
    const preferred = this.config().hosts.preferred;
    if (preferred !== undefined) return preferred;
    const installed = HOST_IDS.find((h) => this.deps.adapters[h] !== undefined);
    return installed ?? (HOST_IDS[0] as HostId);
  }

  allStates(): Iterable<RunState> {
    return [...this.finished.values(), ...[...this.handles.values()].map((h) => h.state)];
  }

  /** Every run, oldest first (the read model's source). */
  states(): RunState[] {
    return [...this.allStates()].sort(
      (a, b) => a.run.started_at.localeCompare(b.run.started_at) || a.id.localeCompare(b.id),
    );
  }

  onEvent(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves once no background job is running (tests, clean shutdown). */
  async settle(): Promise<void> {
    while (this.jobs.size > 0) await Promise.allSettled([...this.jobs.values()]);
    await Promise.allSettled([...this.chains.values()]);
  }

  /** True while a run has work or a job runs (the daemon's idle exit waits for this, AD-12 rule 4). */
  hasWork(): boolean {
    return (
      this.jobs.size > 0 ||
      [...this.handles.values()].some((h) => h.state.run.finished_at === undefined)
    );
  }

  /** Background work or role runs in flight: the daemon does not idle out (AD-12 rule 4). */
  busy(): boolean {
    return (
      this.jobs.size > 0 || [...this.handles.values()].some((h) => inFlight(h.state).length > 0)
    );
  }

  /**
   * An incident report (§15): an unclean end found on start (a stale lock, a torn log). Recorded
   * in the active run's log, so the run summary and the dashboard show it.
   */
  recordIncident(kind: "crash" | "kill" | "stale_lock", detail: string): void {
    const state = activeRun([...this.handles.values()].map((h) => h.state));
    const handle = state === undefined ? undefined : this.handles.get(state.id);
    if (handle === undefined) return;
    this.emit(handle, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind, detail: detail.slice(0, 2000) },
    });
  }

  /** The next scheduled auto-resume across runs, if any (the daemon keeps the timer, §6.9). */
  autoResumeAt(): string | null {
    const times = [...this.handles.values()]
      .map((h) => h.state.limit?.autoResumeAt ?? null)
      .filter((t): t is string => t !== null);
    return times.sort()[0] ?? null;
  }

  // ------------------------------------------------------------ transitions

  /** Engine-internal transitions (no Lead involved) until nothing changes; starts jobs. */
  advance(handle: RunHandle): void {
    for (let i = 0; i < 20; i += 1) {
      if (handle.state.run.finished_at !== undefined || !this.handles.has(handle.state.id)) return;
      if (!this.step(handle)) return;
    }
  }

  private phaseTo(handle: RunHandle, to: Phase): void {
    this.emit(handle, {
      type: "run.phase_changed",
      actor: "engine",
      data: { from: handle.state.run.phase, to },
    });
  }

  /** One pass of `advance`; true when something changed. */
  private step(handle: RunHandle): boolean {
    const state = handle.state;
    const phase = state.run.phase;
    const roles = phaseRoles(handle, phase);
    if (["discover", "specify", "design"].includes(phase)) {
      const entered = phaseEnteredSeq(state, phase) ?? 0;
      const done = roles.every(
        ({ role, mode }) =>
          lastSubmitted(state, { role, ...(mode === undefined ? {} : { mode }) }, entered)?.exit ===
          "done",
      );
      if (!done) return false;
      if (phase === "discover") this.phaseTo(handle, "specify");
      else if (phase === "specify")
        this.phaseTo(handle, state.run.track === "quick_fix" ? "design" : "g1");
      else this.phaseTo(handle, "g2");
      return true;
    }
    if (!["build", "integrate", "final_review", "release"].includes(phase)) return false;
    let changed = this.scheduleTasks(handle);
    for (const task of state.tasks.values()) {
      const gating = this.isRunning(`gates:${task.id}`);
      if (
        task.status === "ready" &&
        task.worktree === undefined &&
        !this.isRunning(`ws:${task.id}`)
      ) {
        ensureWorkspace(this, handle, task.id);
      }
      if (task.status === "ready" && !gating) {
        // recovery: QA's tests are in but their base-fail check never concluded (restart, retry)
        const qa = pendingBaseCheck(state, task.id);
        const tests =
          qa === undefined
            ? undefined
            : loadResult(this.deps.repoRoot, qa.action_id)?.acceptance_tests;
        if (qa?.head !== undefined && tests !== undefined) {
          startBaseCheck(this, handle, task.id, qa.head, tests);
        }
      }
      if (task.status === "verifying" && !gating) {
        const built = lastBuilt(state, task.id);
        const verdict = roundVerdict(state, task.id);
        if (built?.head !== undefined && verdict === undefined) {
          startRoundGates(this, handle, task.id, built.head);
        } else if (
          verdict?.verdict === "pass" &&
          completedReviews(this, handle, task.id) !== null
        ) {
          startTriage(this, handle, task.id);
        }
      }
    }
    if ([...state.tasks.values()].some((t) => t.status === "queued") && !state.run.paused)
      startMergeQueue(this, handle);
    for (const feature of state.features.values()) {
      const tasks = feature.tasks
        .map((id) => state.tasks.get(id))
        .filter((t) => t !== undefined && t.status !== "dropped");
      if (tasks.length === 0) {
        if (feature.tasks.length > 0 && state.run.finished_at === undefined) {
          this.emit(handle, {
            type: "run.finished",
            actor: "engine",
            data: { outcome: "aborted" },
          });
          return false;
        }
        continue;
      }
      const codeComplete = tasks.every((t) =>
        ["built", "queued", "merged", "done"].includes(t?.status ?? ""),
      );
      const merged = tasks.every((t) => ["merged", "done"].includes(t?.status ?? ""));
      if (feature.status === "building" && codeComplete) {
        setFeatureStatus(this, handle, feature.id, "integrating");
        if (state.run.phase === "build") this.phaseTo(handle, "integrate");
        changed = true;
      }
      const current = state.features.get(feature.id);
      if (
        (current?.status === "integrating" || current?.status === "fixing") &&
        merged &&
        !state.run.paused
      ) {
        setFeatureStatus(this, handle, feature.id, "final_review");
        if (state.run.phase !== "final_review") this.phaseTo(handle, "final_review");
        startFinalReview(this, handle, feature.id);
        changed = true;
      } else if (
        current?.status === "final_review" &&
        !this.isRunning(`final:${feature.id}`) &&
        !state.run.paused
      ) {
        startFinalReview(this, handle, feature.id);
      }
      if (
        state.features.get(feature.id)?.status === "ready_to_ship" &&
        !this.isRunning(`release:${feature.id}`) &&
        !state.run.paused
      ) {
        if (state.run.phase !== "release") {
          this.phaseTo(handle, "release");
          changed = true;
        }
        startRelease(this, handle, feature.id);
      }
    }
    return changed;
  }

  /** The scheduler (§6.6): waiting tasks start when a slot, scopes and dependencies allow. */
  private scheduleTasks(handle: RunHandle): boolean {
    const state = handle.state;
    if (
      state.run.phase !== "build" &&
      state.run.phase !== "integrate" &&
      state.run.phase !== "final_review"
    )
      return false;
    const config = this.config();
    const host = this.hostFor({ host: null });
    const fiveHour = this.usage.get(host)?.windows.find((w) => w.kind === "five_hour");
    const tasks = [...state.tasks.values()];
    const decision = schedule({
      tasks: state.tasks,
      frozenContracts: new Set(state.contracts.keys()),
      order: tasks.map((t) => t.id),
      scopes: new Map(tasks.map((t) => [t.id, t.files_scope])),
      concurrency: config.concurrency,
      busySlots: inFlight(state).length + tasks.filter((t) => t.status === "ready").length,
      remainingPct: fiveHour === undefined ? null : remainingPct(fiveHour),
      reservePct: config.usage.reserve_pct,
      paused: state.run.paused || limitWait(this, handle) !== null,
    });
    for (const id of decision.waiting) setTaskStatus(this, handle, id, "waiting_dependency");
    for (const id of decision.start) {
      setTaskStatus(this, handle, id, "ready");
      ensureWorkspace(this, handle, id);
    }
    return decision.waiting.length > 0 || decision.start.length > 0;
  }

  // ------------------------------------------------------------------ tools

  private resolve(run: string | undefined): RunHandle {
    if (run !== undefined) {
      const handle = this.handles.get(run);
      if (handle !== undefined) return handle;
      if (this.finished.has(run)) throw new EngineError("finished", `run ${run} has finished`);
      throw new EngineError("no_run", `no run ${run}`);
    }
    const state = activeRun([...this.handles.values()].map((h) => h.state));
    const handle = state === undefined ? undefined : this.handles.get(state.id);
    if (handle === undefined) throw new EngineError("no_run", "no active run; start one first");
    return handle;
  }

  private stateOf(run: string | undefined): RunState {
    if (run !== undefined && this.finished.has(run)) return this.finished.get(run) as RunState;
    if (run === undefined && this.handles.size === 0) {
      const last = this.states().at(-1);
      if (last !== undefined) return last;
    }
    return this.resolve(run).state;
  }

  async start(input: StartInput, _call: CallContext): Promise<StartResult> {
    if ([...this.handles.values()].some((h) => h.state.run.finished_at === undefined)) {
      throw new EngineError(
        "run_active",
        "a run is already active in this repo; finish or pause it first",
      );
    }
    const config = this.config();
    const gates = this.gatesConfig();
    const track = config.track_default ?? input.track;
    const id = this.newRunId();
    const log = openEventLog(this.deps.repoRoot, id, this.deps.lock, {
      now: this.deps.now,
      secrets: () => this.secrets(),
    });
    const handle: RunHandle = { state: emptyRunState(id, this.now().toISOString()), log };
    this.handles.set(id, handle);
    return this.serial(handle, () => {
      this.emit(handle, {
        type: "run.started",
        actor: "engine",
        data: {
          request: input.request,
          track,
          repo: input.repo,
          has_ui: input.has_ui,
          risk_hints: input.risk_hints,
          merge_level: config.merge_level,
          pipeline_config_hash: pipelineConfigHash(config, gates),
        },
      });
      this.phaseTo(handle, track === "quick_fix" ? "specify" : "discover");
      this.advance(handle);
      return Promise.resolve({ run: id, track, phase: handle.state.run.phase });
    });
  }

  private newRunId(): string {
    const stamp = this.now()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..*$/, "")
      .replace("T", "-");
    let id = `r${stamp}`;
    for (
      let n = 2;
      this.handles.has(id) ||
      this.finished.has(id) ||
      existsSync(join(this.deps.repoRoot, ".vtc/runs", id));
      n += 1
    ) {
      id = `r${stamp}-${String(n)}`;
    }
    return id;
  }

  /** The gates awaiting the human in this phase, with what to show (§6.2). */
  private awaitingGates(
    handle: RunHandle,
  ): { gates: HumanGateId[]; artifacts: FrozenArtifact[] } | null {
    const state = handle.state;
    const phase = state.run.phase;
    if (phase !== "g1" && phase !== "g2") return null;
    const gates: HumanGateId[] =
      phase === "g1" ? ["G1"] : state.run.track === "quick_fix" ? ["G1", "G2"] : ["G2"];
    const roles = [
      ...(gates.includes("G1") ? ["ba"] : []),
      ...(gates.includes("G2") ? ["architect", "designer"] : []),
    ];
    const paths = new Set<string>();
    for (const role of roles) {
      const run = lastSubmitted(state, { role });
      const submitted = state.events.find(
        (e) =>
          e.type === "role.submitted" &&
          (e.data as { action_id?: string }).action_id === run?.action_id,
      );
      for (const a of (submitted?.data as { artifacts?: { path: string }[] } | undefined)
        ?.artifacts ?? [])
        paths.add(a.path);
    }
    const artifacts = [...paths].flatMap((path) => {
      const sha256 = sha256File(join(this.deps.repoRoot, path));
      return sha256 === undefined ? [] : [{ path, sha256 }];
    });
    return artifacts.length === 0 ? null : { gates, artifacts };
  }

  /** What the Lead should do now (§4.2 step 1). */
  private actionsFor(handle: RunHandle, call: CallContext): LeadAction[] {
    const state = handle.state;
    if (state.run.finished_at !== undefined) {
      const summary = state.events.findLast((e) => e.type === "run.finished");
      const path = (summary?.data as { summary?: string } | undefined)?.summary;
      return [{ type: "done", ...(path === undefined ? {} : { summary: path }) }];
    }
    maybeAutoResume(this, handle);
    this.advance(handle);
    const actions: LeadAction[] = dispatchNow(this, handle, call);
    const gate = this.awaitingGates(handle);
    if (gate !== null) {
      actions.push({
        type: "approve_gate",
        gates: gate.gates,
        artifacts: gate.artifacts,
        design_directions: [],
        unverified_facts: [],
      });
    }
    const open = openEscalations(state);
    if (open.length > 0) actions.push({ type: "ask_human", escalations: open.map((e) => e.id) });
    if (actions.length === 0) actions.push(this.waitAction(handle));
    return actions;
  }

  private waitAction(handle: RunHandle): LeadAction {
    const state = handle.state;
    if (state.run.paused)
      return { type: "wait", reason: "the run is paused (vtc resume to continue)", until: null };
    const limit = limitWait(this, handle);
    if (limit !== null)
      return {
        type: "wait",
        reason: "a usage limit was hit; the engine resumes after the reset",
        until: limit,
      };
    const flying = inFlight(state).length;
    if (flying > 0)
      return {
        type: "wait",
        reason: `${String(flying)} role run(s) in flight; submit their results`,
        until: null,
      };
    const jobs = [...this.jobs.keys()].filter(
      (k) =>
        k.endsWith(state.id) ||
        [...state.tasks.keys(), ...state.features.keys()].some((id) => k.endsWith(`:${id}`)),
    );
    if (jobs.length > 0)
      return { type: "wait", reason: `the engine is working (${jobs.join(", ")})`, until: null };
    const parked = [...state.tasks.values()].filter((t) => t.status === "parked").length;
    if (parked > 0)
      return {
        type: "wait",
        reason: `${String(parked)} task(s) parked; answer their escalations`,
        until: null,
      };
    return { type: "wait", reason: "nothing to dispatch right now", until: null };
  }

  async next(input: RunScopedInput, call: CallContext): Promise<NextResult> {
    const state = this.stateOf(input.run);
    const handle = this.handles.get(state.id);
    if (handle === undefined) return { run: state.id, actions: this.actionsForFinished(state) };
    return this.serial(handle, () =>
      Promise.resolve({ run: state.id, actions: this.actionsFor(handle, call) }),
    );
  }

  private actionsForFinished(state: RunState): LeadAction[] {
    const finished = state.events.findLast((e) => e.type === "run.finished");
    const path = (finished?.data as { summary?: string } | undefined)?.summary;
    return [{ type: "done", ...(path === undefined ? {} : { summary: path }) }];
  }

  async submit(input: SubmitInput, call: CallContext): Promise<SubmitResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, async () => {
      const outcome = await handleSubmit(this, handle, input);
      this.advance(handle);
      const actions = this.actionsFor(handle, call);
      return outcome.accepted
        ? { run: handle.state.id, accepted: true, actions }
        : { run: handle.state.id, accepted: false, rejection: outcome.rejection, actions };
    });
  }

  /**
   * A `submit` whose input failed the schema (AD-4 Check): logged as `role.rejected` `schema`
   * when it names an open action, so the step is re-dispatched; `null` when it names none.
   */
  async rejectMalformedSubmit(
    runId: string | undefined,
    actionId: string,
    issues: readonly string[],
    call: CallContext,
  ): Promise<SubmitResult | null> {
    let handle: RunHandle;
    try {
      handle = this.resolve(runId);
    } catch {
      return null;
    }
    const run = handle.state.roleRuns.get(actionId);
    if (run?.status !== "in_flight") return null;
    return this.serial(handle, () => {
      const rejection = {
        reason: "schema" as const,
        issues: issues.slice(0, 20).map((i) => i.slice(0, 500)),
      };
      this.emit(handle, {
        type: "role.rejected",
        actor: "engine",
        role: run.role,
        ...(run.task === undefined ? {} : { task: run.task }),
        data: { action_id: actionId, ...rejection },
      });
      return Promise.resolve({
        run: handle.state.id,
        accepted: false,
        rejection,
        actions: this.actionsFor(handle, call),
      });
    });
  }

  status(input: RunScopedInput): StatusResult {
    return statusView(this.stateOf(input.run), this.usage);
  }

  escalations(input: RunScopedInput): EscalationList {
    return escalationListView(this.stateOf(input.run));
  }

  async answer(input: AnswerInput, call: CallContext): Promise<NextResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, () => {
      const escalation = handle.state.escalations.get(input.escalation);
      if (escalation === undefined)
        throw new EngineError("invalid", `no escalation ${input.escalation}`);
      if (escalation.answer !== undefined)
        throw new EngineError("conflict", `${input.escalation} is already answered`);
      if (!escalation.options.some((o) => o.id === input.answer.option)) {
        throw new EngineError(
          "invalid",
          `option ${input.answer.option} is not one of ${escalation.options.map((o) => o.id).join(", ")}`,
        );
      }
      this.emit(handle, {
        type: "escalation.answered",
        actor: "human",
        ...(escalation.task === undefined ? {} : { task: escalation.task }),
        ...(escalation.feature === undefined ? {} : { feature: escalation.feature }),
        data: { escalation: escalation.id, answer: input.answer },
      });
      const cr = handle.state.changeRequests.get(escalation.id);
      const effect = escalation.options.find((o) => o.id === input.answer.option)?.effect;
      if (cr !== undefined && (effect === "approve_change" || effect === "reject_change")) {
        const sha = sha256File(join(this.deps.repoRoot, cr.frozen.path));
        this.emit(handle, {
          type: "change_request.decided",
          actor: "human",
          data: {
            escalation: escalation.id,
            decision: effect === "approve_change" ? "approved" : "rejected",
            frozen: cr.frozen,
            ...(effect === "approve_change" ? { new_sha256: sha ?? cr.frozen.sha256 } : {}),
          },
        });
      }
      if (
        escalation.feature !== undefined &&
        escalation.task === undefined &&
        handle.state.features.get(escalation.feature)?.status === "parked"
      ) {
        this.resumeFeature(handle, escalation.feature, effect);
      }
      applyAnswer(this, handle, escalation, input.answer);
      this.advance(handle);
      return Promise.resolve({ run: handle.state.id, actions: this.actionsFor(handle, call) });
    });
  }

  private resumeFeature(handle: RunHandle, featureId: string, effect: string | undefined): void {
    if (effect === "drop") {
      this.emit(handle, { type: "run.finished", actor: "engine", data: { outcome: "aborted" } });
      return;
    }
    const before = handle.state.events.findLast(
      (e) =>
        e.feature === featureId &&
        e.type === "feature.status_changed" &&
        (e.data as { to?: string }).to === "parked",
    );
    const from = (before?.data as { from?: string } | undefined)?.from;
    setFeatureStatus(
      this,
      handle,
      featureId,
      from === "fixing" || from === "final_review" ? "final_review" : "integrating",
    );
  }

  async approve(input: ApproveInput, call: CallContext): Promise<NextResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, () => {
      const awaiting = this.awaitingGates(handle);
      if (awaiting === null)
        throw new EngineError(
          "conflict",
          `no gate is awaiting approval (phase ${handle.state.run.phase})`,
        );
      const want = [...awaiting.gates].sort().join(",");
      if ([...input.gates].sort().join(",") !== want)
        throw new EngineError("invalid", `the gates awaiting a decision are ${want}`);
      const shown = new Map(awaiting.artifacts.map((a) => [a.path, a.sha256]));
      const problems = input.frozen.flatMap((f) =>
        shown.get(f.path) === f.sha256
          ? []
          : [`${f.path} is not shown at ${f.sha256.slice(0, 12)} (it changed or was not shown)`],
      );
      for (const path of shown.keys())
        if (!input.frozen.some((f) => f.path === path)) problems.push(`${path} must be frozen too`);
      if (problems.length > 0) throw new EngineError("conflict", problems.join("; "));
      const back: Phase = handle.state.run.phase === "g1" ? "specify" : "design";
      if (input.decision === "approve") {
        this.emit(handle, {
          type: "gate.approved",
          actor: "human",
          data: {
            gates: input.gates,
            frozen: input.frozen,
            ...(input.design_direction === undefined
              ? {}
              : { design_direction: input.design_direction }),
            waived_facts: input.waived_facts,
            ...(input.note === undefined ? {} : { note: input.note }),
          },
        });
        this.phaseTo(handle, handle.state.run.phase === "g1" ? "design" : "plan");
      } else {
        this.emit(handle, {
          type: "gate.rejected",
          actor: "human",
          data: { gates: input.gates, ...(input.note === undefined ? {} : { note: input.note }) },
        });
        this.phaseTo(handle, handle.state.run.track === "quick_fix" ? "specify" : back);
      }
      this.advance(handle);
      return Promise.resolve({ run: handle.state.id, actions: this.actionsFor(handle, call) });
    });
  }

  async changeRequest(input: ChangeRequestInput): Promise<ChangeRequestResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, () => {
      const state = handle.state;
      let frozen: FrozenArtifact | undefined;
      if (input.artifact === "interface_contract") {
        const contract = input.task === undefined ? undefined : state.contracts.get(input.task);
        frozen =
          contract === undefined ? undefined : { path: contract.path, sha256: contract.sha256 };
      } else {
        const prefix = {
          spec: ".vtc/spec/",
          architecture: ".vtc/architecture/",
          design: ".vtc/design/",
        }[input.artifact];
        frozen = [...state.run.gates.G1.frozen, ...state.run.gates.G2.frozen].find((f) =>
          f.path.startsWith(prefix),
        );
      }
      if (frozen === undefined)
        throw new EngineError("conflict", `no frozen ${input.artifact} to change`);
      const id = nextEscalationId(state);
      const escalation = parkEscalation({
        id,
        run: state.id,
        ...(input.task === undefined ? { phase: state.run.phase } : { task: input.task }),
        reason: "change_request",
        detail: input.detail,
        evidence: [{ type: "file", ref: frozen.path }],
        blocks: [],
        now: this.now(),
      });
      this.emit(handle, {
        type: "escalation.opened",
        actor: "engine",
        ...(input.task === undefined ? {} : { task: input.task }),
        data: {
          escalation: {
            ...escalation,
            question: `Approve this change request? ${input.summary}`.slice(0, 1000),
          },
        },
      });
      this.emit(handle, {
        type: "change_request.opened",
        actor: "human",
        data: {
          escalation: id,
          artifact: input.artifact,
          frozen,
          ...(input.task === undefined ? {} : { task: input.task }),
          summary: input.summary,
        },
      });
      return Promise.resolve({ run: state.id, escalation: id });
    });
  }

  async pause(input: RunScopedInput): Promise<RunControlResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, () => {
      if (!handle.state.run.paused) {
        this.emit(handle, {
          type: "run.paused",
          actor: "human",
          data: { reason: "vtc pause (kill switch)" },
        });
      }
      return Promise.resolve({ run: handle.state.id, paused: true, phase: handle.state.run.phase });
    });
  }

  /**
   * Resumes a paused or interrupted run (AD-4): role runs still marked in flight belong to a
   * session that is gone, so they are closed and their steps re-dispatched.
   */
  async resume(input: RunScopedInput): Promise<RunControlResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, () => {
      const state = handle.state;
      for (const run of inFlight(state)) {
        this.emit(handle, {
          type: "role.failed",
          actor: "engine",
          role: run.role,
          ...(run.task === undefined ? {} : { task: run.task }),
          data: {
            action_id: run.action_id,
            kind: "error",
            message: "superseded: the run was resumed",
            retryable: true,
          },
        });
      }
      if (state.run.paused)
        this.emit(handle, { type: "run.resumed", actor: "human", data: { auto: false } });
      maybeAutoResume(this, handle);
      this.advance(handle);
      return Promise.resolve({ run: state.id, paused: state.run.paused, phase: state.run.phase });
    });
  }

  /** Stores a usage reading (statusline ingest, SDK events, Codex app-server; §6.9). */
  ingestUsage(snapshot: UsageSnapshot): void {
    const before = this.usage.get(snapshot.host);
    this.usage.set(snapshot.host, snapshot);
    if (!significant(before, snapshot)) return;
    const state = activeRun([...this.handles.values()].map((h) => h.state));
    const handle = state === undefined ? undefined : this.handles.get(state.id);
    if (handle === undefined) return;
    void this.serial(handle, () => {
      this.emit(handle, { type: "usage.updated", actor: "engine", data: { snapshot } });
      return Promise.resolve();
    });
  }

  /** The auto-resume timer fired (`vtc engine --daemon --wake`, AD-12 rule 4). */
  async wake(): Promise<void> {
    for (const handle of this.handles.values()) {
      await this.serial(handle, () => {
        maybeAutoResume(this, handle);
        this.advance(handle);
        return Promise.resolve();
      });
    }
  }

  /** Active (non-terminal, non-waiting) tasks: the daemon stays up for them. */
  activeTasks(): number {
    return [...this.handles.values()].reduce(
      (n, h) =>
        n +
        [...h.state.tasks.values()].filter((t) => ACTIVE_TASK_STATUSES.includes(t.status)).length,
      0,
    );
  }
}
