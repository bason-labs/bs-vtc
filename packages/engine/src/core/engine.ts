/**
 * The engine (§4.1, §4.2; AD-4, AD-7, AD-8): owns every run's state, rebuilt from the event logs
 * on open, and answers the Lead-facing tools. The Lead only ever dispatches what `next` returns;
 * the engine decides every transition, cap, budget and route (D11).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { setGitPreflight, setGitSigning, writeRepoFile } from "../git/index.js";
import { join } from "node:path";
import {
  dotenvValues,
  eventLogPath,
  HOST_IDS,
  PACK_INPUT_TYPES,
  parseEventLog,
  remainingPct,
  type ApproveInput,
  type AnswerInput,
  type ChangeRequestInput,
  type ChangeRequestResult,
  type ConsultInput,
  type ConsultResult,
  type EscalationList,
  type FrozenArtifact,
  type GatesConfig,
  GatesConfigSchema,
  ProjectConfigSchema,
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
import { dispatchGuarded, dispatchNow, phaseRoles } from "./dispatch.js";
import { parkEscalation } from "./escalations.js";
import {
  acceptCheckout,
  checkLeftoverGates,
  checkLeftoverRecords,
  dropGates,
  findLostLogs,
  FORENSICS_DIR,
  gitPreflight,
  loadGitHold,
  loadHeldRuns,
  releaseHeldRuns,
  removeLostLogs,
  reportUnverifiable,
  restoreDispatches,
  restoreGates,
  restoreLog,
  saveHeldRuns,
  sweepDispatches,
  type DispatchRecord,
} from "./dispatch-guard.js";
import { EngineWrites, NEVER_WROTE } from "./engine-writes.js";
import { appendPrivateFile, ensurePrivateDir, guardDirFor } from "./guard.js";
import { openEventLog, type EventDraft } from "./event-log.js";
import {
  downgradeNoRemote,
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
import { applyEvent, emptyRunState, projectRun, type RunState } from "./state.js";
import { ArtifactRefSchema } from "@vtc/shared";
import { checkEngineerShare, handleSubmit } from "./submit.js";
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

/** The config a run started with (AD-4 Prevents, AD-8 rule 5: agents never set caps or budgets). */
interface FrozenConfig {
  readonly run: string;
  readonly project: ProjectConfig;
  readonly gates: GatesConfig | null;
  /** `pipelineConfigHash(project, gates)`. */
  readonly hash: string;
}

/** Where a run's frozen config is kept for a restart (checked against `run.started`'s hash). */
const frozenConfigPath = (run: string): string => `.vtc/state/runs/${run}/config.json`;

export class Engine implements Kernel {
  readonly usage = new Map<HostId, UsageSnapshot>();
  readonly identicalTree = new Map<string, boolean>();
  readonly dispatches = new Map<string, DispatchRecord>();
  readonly guardDir: string;
  readonly writes: EngineWrites;
  /**
   * What `open` found and could not record in a run's log (a finished run's log cut back to its
   * verified prefix, a log with nothing verified left): the daemon prints them.
   */
  readonly notices: string[] = [];
  gitHold: Readonly<Record<string, string>> | null = null;
  readonly gateBaselines = new Map<string, Readonly<Record<string, string>>>();
  /** Runs `open` could not verify, run → reason (`checkLeftoverRecords`, `findLostLogs`). */
  private held = new Map<string, string>();
  private readonly handles = new Map<string, RunHandle>();
  private readonly finished = new Map<string, RunState>();
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly listeners = new Set<EventListener>();
  private readonly fileCache = new Map<string, { stamp: number; value: unknown }>();
  private frozen: FrozenConfig | null = null;
  /** Modification stamps of the config files when drift was last checked. */
  private driftStamps = "";
  /** The Lead's MCP session per run (spine §7: Lead-only tools are refused from role sessions). */
  private readonly leads = new Map<string, string>();
  /** A role session's one action (`run/action`): it may submit nothing else. */
  private readonly bound = new Map<string, string>();

  private constructor(readonly deps: EngineCoreDeps) {
    this.guardDir = guardDirFor(deps.vtcHome, deps.repoRoot);
    ensurePrivateDir(this.guardDir);
    this.writes = EngineWrites.open(deps.repoRoot, join(this.guardDir, "engine-writes.jsonl"));
  }

  /**
   * Opens the engine on a repo: replays every run's log (AD-7 rule 5) and recovers its work. A log
   * is replayed only as far as the engine's ledger vouches for it (`EngineWrites.verifiedPrefix`):
   * anything else (an in-place edit, an inserted or appended line, a cut) is moved aside to
   * {@link FORENSICS_DIR}, the log is cut back to that prefix, and the run pauses saying so, a
   * finished one included (it is finished only if its verified prefix says so). An unfinished
   * log this engine never wrote (another clone's, or a planted one) pauses too. A role run in
   * flight without its dispatch record cannot be verified and pauses its run.
   *
   * A log the ledger knows that is gone, holds no event, or nothing it vouches for is lost: it is
   * said, kept aside, and its run is held. Every record of a run that is not active is checked
   * before it is dropped (a git change is held); a record whose check finds anything holds its
   * run too. While a run is held, no run starts, an active run pauses, and the held runs'
   * records keep holding engine git until the human's `vtc resume`. A gate run the daemon stopped
   * in the middle of left its git baseline in the guard directory: it holds engine git from the
   * start of `open`, and is checked before anything runs git (a change is held and reported,
   * its run paused or held) and dropped (`checkLeftoverGates`).
   */
  static open(deps: EngineCoreDeps): Engine {
    const engine = new Engine(deps);
    restoreDispatches(engine);
    // gate runs the daemon stopped in the middle of: their baselines hold engine git from here on
    const gates = restoreGates(engine);
    engine.gitHold = loadGitHold(engine);
    engine.held = loadHeldRuns(engine);
    const wasHeld = new Map(engine.held);
    const lost = new Map<string, string>();
    setGitPreflight(deps.repoRoot, () => {
      gitPreflight(engine);
    });
    setGitSigning(deps.repoRoot, () => {
      try {
        return engine.config().git.sign_commits;
      } catch {
        return false;
      }
    });
    for (const loaded of loadRuns(deps.repoRoot)) {
      let state = loaded.state;
      const rel = eventLogPath(state.id);
      const verdict = engine.writes.check(rel);
      let tampered: string | undefined;
      if (!verdict.ok && verdict.detail === NEVER_WROTE) {
        engine.writes.accept(rel);
        if (state.run.finished_at === undefined)
          tampered = `${rel} was not written by this engine install (another clone's log, or one written by hand); it was replayed as it is`;
      } else if (!verdict.ok) {
        const bytes = readFileSync(join(deps.repoRoot, rel));
        const verified = engine.writes.verifiedPrefix(rel);
        const prefix = bytes.subarray(0, verified);
        const kept = `${FORENSICS_DIR}/${state.id}-open-${String(Date.now())}.jsonl`;
        writeRepoFile(deps.repoRoot, kept, bytes, 0o600);
        const events = parseEventLog(prefix.toString("utf8")).events.filter(
          (e) => e.run === state.id,
        );
        if (events.length === 0) {
          // nothing the engine wrote is left: the run cannot be rebuilt, it is lost
          lost.set(
            state.id,
            `${rel} was changed outside the engine (${verdict.detail}); none of it is what the engine wrote, so the run cannot be rebuilt. The changed file (${String(bytes.byteLength)} bytes) is kept at ${kept}`,
          );
          continue;
        }
        writeRepoFile(deps.repoRoot, rel, prefix);
        state = projectRun(events);
        tampered = `${rel} was changed outside the engine (${verdict.detail}); the engine replayed only its first ${String(events.length)} event(s), the ${String(verified)} bytes its ledger vouches for, and cut the log back to them. The changed file (${String(bytes.byteLength)} bytes) is kept at ${kept}`;
      }
      for (const [host, snapshot] of state.usage) engine.usage.set(host, snapshot);
      if (state.run.finished_at !== undefined) {
        // the verified prefix finished the run: nothing to resume (a cut forged tail is reported)
        engine.finished.set(state.id, state);
        if (tampered !== undefined) engine.notices.push(tampered);
        continue;
      }
      const log = openEventLog(deps.repoRoot, state.id, deps.lock, {
        now: deps.now,
        secrets: () => engine.secrets(),
      });
      const handle: RunHandle = { state, log };
      engine.handles.set(state.id, handle);
      if (tampered !== undefined) engine.reportLogOnOpen(handle, tampered);
      engine.restoreFrozenConfig(handle);
      reportUnverifiable(engine, handle);
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
    findLostLogs(engine, new Set([...engine.handles.keys(), ...engine.finished.keys()]), lost);
    for (const [run, reason] of lost) {
      engine.notices.push(`${reason}; run ${run} is held until vtc resume`);
      engine.held.set(run, reason);
    }
    // A record is dropped only after its check, whatever became of its run.
    const checkedGates = checkLeftoverGates(
      engine,
      gates,
      engine.handles,
      engine.held,
      engine.notices,
    );
    checkLeftoverRecords(engine, new Set(engine.handles.keys()), engine.held, engine.notices);
    for (const [run, reason] of wasHeld)
      if (!lost.has(run)) engine.notices.push(`run ${run} is held until vtc resume: ${reason}`);
    saveHeldRuns(engine, engine.held);
    dropGates(engine, checkedGates);
    // only once the hold is kept: a crash before this finds the logs lost again
    removeLostLogs(engine, lost);
    const fresh = [...engine.held].filter(([run]) => !wasHeld.has(run));
    if (fresh.length > 0)
      for (const handle of engine.handles.values()) engine.reportHeld(handle, fresh);
    for (const handle of engine.handles.values()) engine.advance(handle);
    return engine;
  }

  /** Runs `open` could not verify: an active run pauses saying so (see `open`). */
  private reportHeld(handle: RunHandle, held: readonly (readonly [string, string])[]): void {
    if (handle.state.run.finished_at !== undefined) return;
    const runs = held.map(([run]) => run).join(", ");
    this.emit(handle, {
      type: "incident.recorded",
      actor: "engine",
      data: {
        kind: "checkout_write",
        detail:
          `the engine could not verify run(s) ${runs} when it opened: ${held.map(([, reason]) => reason).join("; ")}`.slice(
            0,
            2000,
          ),
      },
    });
    this.emit(handle, {
      type: "run.paused",
      actor: "engine",
      data: {
        reason:
          `run(s) ${runs} could not be verified when the engine opened (see the incident); check the repo, then vtc resume`.slice(
            0,
            300,
          ),
      },
    });
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

  /** The active run's frozen config, if a run is active. */
  private activeFrozen(): FrozenConfig | null {
    const frozen = this.frozen;
    if (frozen === null) return null;
    const handle = this.handles.get(frozen.run);
    return handle !== undefined && handle.state.run.finished_at === undefined ? frozen : null;
  }

  private diskProject(): ProjectConfig {
    try {
      return this.cached(PROJECT_CONFIG_PATH, () => loadProjectConfig(this.deps.repoRoot));
    } catch (error) {
      if (error instanceof ConfigError) throw new EngineError("config", error.message);
      throw error;
    }
  }

  private diskGates(): GatesConfig | null {
    try {
      return this.cached(GATES_CONFIG_PATH, () => loadGatesConfig(this.deps.repoRoot));
    } catch (error) {
      if (error instanceof ConfigError) throw new EngineError("config", error.message);
      throw error;
    }
  }

  /**
   * `project.yaml` as the active run started with it: a run's config is frozen at `run.started`
   * (`pipeline_config_hash`), so an edit mid-run (by anyone, an agent included) never changes
   * caps, budgets, the merge level or the dispatch mode of a running run. Between runs, the file.
   */
  config(): ProjectConfig {
    return this.activeFrozen()?.project ?? this.diskProject();
  }

  /** `gates.yml` as the active run started with it (see {@link config}). */
  gatesConfig(): GatesConfig | null {
    const frozen = this.activeFrozen();
    return frozen === null ? this.diskGates() : frozen.gates;
  }

  /** Freezes `project` and `gates` for `run` and keeps a copy for a restart. */
  private freezeConfig(run: string, project: ProjectConfig, gates: GatesConfig | null): void {
    this.frozen = { run, project, gates, hash: pipelineConfigHash(project, gates) };
    this.driftStamps = this.configStamps();
    try {
      writeRepoFile(
        this.deps.repoRoot,
        frozenConfigPath(run),
        `${JSON.stringify({ project, gates })}\n`,
        0o600,
      );
    } catch {
      // only a restart needs the copy; the run's hash still detects any change
    }
  }

  /**
   * On open: the run's frozen config is the kept copy when it matches the run's hash, else the
   * files when they match it. When neither does, the run continues with the current files and
   * pauses, saying so (the change is never applied silently).
   */
  private restoreFrozenConfig(handle: RunHandle): void {
    const run = handle.state.run;
    if (run.finished_at !== undefined || !handle.state.events.some((e) => e.type === "run.started"))
      return;
    try {
      const kept = JSON.parse(
        readFileSync(join(this.deps.repoRoot, frozenConfigPath(handle.state.id)), "utf8"),
      ) as { project?: unknown; gates?: unknown };
      const project = ProjectConfigSchema.parse(kept.project);
      const gates = kept.gates === null ? null : GatesConfigSchema.parse(kept.gates);
      if (pipelineConfigHash(project, gates) === run.pipeline_config_hash) {
        this.frozen = { run: handle.state.id, project, gates, hash: run.pipeline_config_hash };
        this.driftStamps = "";
        return;
      }
    } catch {
      // no usable copy: fall back to the files
    }
    let project: ProjectConfig;
    let gates: GatesConfig | null;
    try {
      project = this.diskProject();
      gates = this.diskGates();
    } catch {
      return; // the files do not parse: config() reports it until they are fixed
    }
    this.freezeConfig(handle.state.id, project, gates);
    const hash = pipelineConfigHash(project, gates);
    if (hash !== run.pipeline_config_hash) this.reportConfigDrift(handle, hash, "restart");
  }

  /** Stamps of the config files (changes when either is written). */
  private configStamps(): string {
    return [PROJECT_CONFIG_PATH, GATES_CONFIG_PATH]
      .map((p) => {
        try {
          return String(statSync(join(this.deps.repoRoot, p)).mtimeMs);
        } catch {
          return "-";
        }
      })
      .join("|");
  }

  /**
   * A config change during the active run (spine §5 reading 20): recorded as an incident of kind
   * `config_changed` (once per change); the run keeps its frozen config and does not pause.
   */
  private checkConfigDrift(handle: RunHandle): void {
    const frozen = this.activeFrozen();
    if (frozen?.run !== handle.state.id) return;
    const stamps = this.configStamps();
    if (stamps === this.driftStamps) return;
    this.driftStamps = stamps;
    let hash: string;
    try {
      hash = pipelineConfigHash(this.diskProject(), this.diskGates());
    } catch {
      hash = "unreadable";
    }
    if (hash !== frozen.hash) this.reportConfigDrift(handle, hash, "edit");
  }

  private reportConfigDrift(handle: RunHandle, hash: string, when: "edit" | "restart"): void {
    const tag = `config ${hash.slice(0, 12)}`;
    const reported = handle.state.events.some(
      (e) =>
        e.type === "incident.recorded" &&
        (e.data as { kind?: string; detail?: string }).kind === "config_changed" &&
        ((e.data as { detail?: string }).detail ?? "").includes(tag),
    );
    if (reported) return;
    this.emit(handle, {
      type: "incident.recorded",
      actor: "engine",
      data: {
        kind: "config_changed",
        detail: (when === "edit"
          ? `project.yaml or gates.yml changed during the run (${tag}${hash === "unreadable" ? ", unreadable" : ""}); the run keeps the config it started with (${handle.state.run.pipeline_config_hash.slice(0, 12)}) and the change applies to the next run`
          : `project.yaml or gates.yml differ from the config this run started with (${tag}) and no copy of it was kept; the run continues with the current files`
        ).slice(0, 2000),
        evidence: [
          { type: "file", ref: PROJECT_CONFIG_PATH },
          { type: "file", ref: GATES_CONFIG_PATH },
        ],
      },
    });
  }

  secrets(): readonly string[] {
    return this.cached(".env", () => {
      const env = join(this.deps.repoRoot, ".env");
      return existsSync(env) ? dotenvValues(readFileSync(env, "utf8")) : [];
    });
  }

  /** The run's log was not what the engine wrote when the engine opened (see `open`). */
  private reportLogOnOpen(handle: RunHandle, detail: string): void {
    this.emit(handle, {
      type: "incident.recorded",
      actor: "engine",
      data: { kind: "log_corruption", detail: detail.slice(0, 2000) },
    });
    this.emit(handle, {
      type: "run.paused",
      actor: "engine",
      data: {
        reason:
          "the run's event log was not what the engine wrote when it opened; only what its ledger vouches for was replayed (see the incident). Check the repo, then vtc resume",
      },
    });
  }

  emit(handle: RunHandle, draft: EventDraft): VtcEvent {
    const event = handle.log.append(draft);
    const foreign = this.writes.foreign(eventLogPath(handle.state.id));
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
    // Someone else appended to the log since the engine's last append: rewritten at once.
    if (foreign !== undefined && this.handles.has(handle.state.id))
      restoreLog(this, handle, foreign);
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

  jobRunningFor(id: string): boolean {
    return [...this.jobs.keys()].some((key) => key.endsWith(`:${id}`));
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
    this.checkConfigDrift(handle);
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
    if (checkEngineerShare(this, handle)) changed = true;
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

  async start(input: StartInput, call: CallContext): Promise<StartResult> {
    if ([...this.handles.values()].some((h) => h.state.run.finished_at === undefined)) {
      throw new EngineError(
        "run_active",
        "a run is already active in this repo; finish or pause it first",
      );
    }
    if (this.held.size > 0) {
      throw new EngineError(
        "conflict",
        `run(s) ${[...this.held.keys()].join(", ")} could not be verified when the engine opened (${[...this.held.values()].join("; ")}`.slice(
          0,
          1500,
        ) + "); check the repo, then vtc resume",
      );
    }
    const config = this.diskProject();
    const gates = this.diskGates();
    const track = config.track_default ?? input.track;
    const id = this.newRunId();
    const log = openEventLog(this.deps.repoRoot, id, this.deps.lock, {
      now: this.deps.now,
      secrets: () => this.secrets(),
    });
    const handle: RunHandle = { state: emptyRunState(id, this.now().toISOString()), log };
    this.handles.set(id, handle);
    this.freezeConfig(id, config, gates);
    if (call.client === "bridge" && call.session !== undefined) this.setLead(id, call, "started");
    const noRemote =
      config.merge_level >= 2 &&
      (await this.deps.workspace.remoteUrl(this.deps.remote).catch(() => null)) === null;
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
      // Level 2+ needs the push remote (spine §5 reading 18).
      if (noRemote) downgradeNoRemote(this, handle);
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
      this.held.has(id) ||
      this.writes.has(eventLogPath(id)) ||
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
  private async actionsFor(handle: RunHandle, call: CallContext): Promise<LeadAction[]> {
    const state = handle.state;
    if (state.run.finished_at !== undefined) {
      const summary = state.events.findLast((e) => e.type === "run.finished");
      const path = (summary?.data as { summary?: string } | undefined)?.summary;
      return [{ type: "done", ...(path === undefined ? {} : { summary: path }) }];
    }
    maybeAutoResume(this, handle);
    this.advance(handle);
    const actions: LeadAction[] = await dispatchNow(this, handle, call);
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
    this.claimLead(state.id, call);
    return this.serial(handle, async () => ({
      run: state.id,
      actions: await this.actionsFor(handle, call),
    }));
  }

  private actionsForFinished(state: RunState): LeadAction[] {
    const finished = state.events.findLast((e) => e.type === "run.finished");
    const path = (finished?.data as { summary?: string } | undefined)?.summary;
    return [{ type: "done", ...(path === undefined ? {} : { summary: path }) }];
  }

  async submit(input: SubmitInput, call: CallContext): Promise<SubmitResult> {
    const handle = this.resolve(input.run);
    this.assertOwnSubmit(handle.state.id, input.action_id, call);
    return this.serial(handle, async () => {
      const outcome = await handleSubmit(this, handle, input);
      this.advance(handle);
      const actions = await this.actionsFor(handle, call);
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
    return this.serial(handle, async () => {
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
      return {
        run: handle.state.id,
        accepted: false as const,
        rejection,
        actions: await this.actionsFor(handle, call),
      };
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
    this.assertLead(handle.state.id, call, "answer");
    return this.serial(handle, async () => {
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
      return { run: handle.state.id, actions: await this.actionsFor(handle, call) };
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
    this.assertLead(handle.state.id, call, "approve");
    return this.serial(handle, async () => {
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
      return { run: handle.state.id, actions: await this.actionsFor(handle, call) };
    });
  }

  async changeRequest(
    input: ChangeRequestInput,
    call: CallContext = { host: null },
  ): Promise<ChangeRequestResult> {
    const handle = this.resolve(input.run);
    this.assertLead(handle.state.id, call, "change_request");
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

  // ------------------------------------------------------------ sessions

  /**
   * The run's Lead session: the bridge session that started the run, or else the first bridge
   * session to drive it (a Lead whose bridge reconnected, or after a restart) that is not bound
   * to a role action. A `submit` never claims it. The cli (`client: cli`) is the human.
   *
   * Defence in depth only: `client` is what the connecting process declares, so a same-uid
   * process that says `cli` is exempt, and a role with a shell can run the cli (spine §7). Each
   * claim is logged in the engine's private directory (`leads.jsonl`) for the human.
   */
  private claimLead(run: string, call: CallContext): void {
    if (call.client !== "bridge" || call.session === undefined) return;
    if (this.leads.has(run) || this.bound.has(call.session)) return;
    this.setLead(run, call, "claimed");
  }

  private setLead(run: string, call: CallContext, how: "started" | "claimed"): void {
    if (call.session === undefined) return;
    this.leads.set(run, call.session);
    try {
      appendPrivateFile(
        join(this.guardDir, "leads.jsonl"),
        `${JSON.stringify({ ts: this.now().toISOString(), run, session: call.session, host: call.host, how })}\n`,
      );
    } catch {
      // the log is for the human; the claim stands without it
    }
  }

  /**
   * Lead-only tools (`approve`, `answer`, `change_request`) are refused from any other bridge
   * session: a role session until the Codex per-agent MCP isolation spike passes (spine §7).
   */
  private assertLead(run: string, call: CallContext, tool: string): void {
    this.claimLead(run, call);
    if (call.client !== "bridge" || call.session === undefined) return;
    if (this.leads.get(run) !== call.session)
      throw new EngineError(
        "forbidden",
        `${tool} is the Lead's tool; a role session may only submit its own result`,
      );
  }

  /** A role session may submit one action only: the first it submits (spine §7). */
  private assertOwnSubmit(run: string, actionId: string, call: CallContext): void {
    if (call.client !== "bridge" || call.session === undefined) return;
    if (this.leads.get(run) === call.session) return;
    const key = `${run}/${actionId}`;
    const own = this.bound.get(call.session);
    if (own === undefined) this.bound.set(call.session, key);
    else if (own !== key)
      throw new EngineError(
        "forbidden",
        `a role session may only submit its own result (${own.split("/").at(-1) ?? own}), not ${actionId}`,
      );
  }

  /** A connection closed: it is no longer any run's Lead, nor bound to an action. */
  sessionClosed(session: string): void {
    for (const [run, lead] of [...this.leads]) if (lead === session) this.leads.delete(run);
    this.bound.delete(session);
  }

  // ------------------------------------------------------------- advisors

  /** The run's advisor spend so far (accepted and failed advisor runs, priced). */
  private advisorSpend(state: RunState): number {
    return state.events
      .filter(
        (e) =>
          (e.type === "role.submitted" || e.type === "role.failed") &&
          e.role !== undefined &&
          this.deps.roles.get(e.role)?.kind === "advisor",
      )
      .reduce((sum, e) => sum + (e.cost_usd ?? 0), 0);
  }

  /**
   * `consult` (§5.4; spine §5 reading 25): the human asked the Lead for an advisor. The engine
   * checks the role is an advisor and the run's advisor budget (`budgets.advisor_usd`) is not
   * spent, writes the pack (the question and the inputs), records the dispatch like any role's
   * (prompt SHA, model, its own worktree, the dispatch guard) and returns the one `spawn_role`.
   * The Lead submits the advisor's result with `submit`, outside the phase flow.
   */
  async consult(input: ConsultInput, call: CallContext): Promise<ConsultResult> {
    const handle = this.resolve(input.run);
    return this.serial(handle, async () => {
      const state = handle.state;
      const contract = this.deps.roles.get(input.advisor);
      if (contract?.kind !== "advisor")
        throw new EngineError("invalid", `${input.advisor} is not an advisor role`);
      if (state.run.paused)
        throw new EngineError("conflict", "the run is paused (vtc resume to continue)");
      const budget = this.config().budgets.advisor_usd;
      const spent = this.advisorSpend(state);
      if (spent >= budget)
        throw new EngineError(
          "conflict",
          `the run's advisor budget is spent ($${spent.toFixed(2)} of $${budget.toFixed(2)}, budgets.advisor_usd)`,
        );
      const question = `${state.id}-${String(state.roleRuns.size + 1)}`;
      const path = `.vtc/state/packs/${state.id}/consult-${question}.md`;
      writeRepoFile(
        this.deps.repoRoot,
        path,
        `# Question for ${input.advisor}\n\n${input.question}\n`,
      );
      const host = this.hostFor(call);
      const action = await dispatchGuarded(
        this,
        handle,
        {
          key: `consult:${input.advisor}`,
          role: input.advisor,
          note: `The human asks: ${input.question}`.slice(0, 4000),
          inputs: [
            ArtifactRefSchema.parse({ type: PACK_INPUT_TYPES.advisorQuestion, path }),
            ...input.inputs.map((i) => ArtifactRefSchema.parse(i)),
          ],
        },
        host,
      );
      if (action === null)
        throw new EngineError("conflict", "the advisor's worktree could not be prepared");
      return { run: state.id, action };
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
   * session that is gone, so they are closed and their steps re-dispatched. Their dispatch
   * records are checked first; anything found keeps the run paused with the reason. Otherwise
   * the human's resume takes the repo as it is (`acceptCheckout`): the run's log is rewritten
   * from the engine's own events, any other file the engine wrote is taken as it now is.
   */
  async resume(input: RunScopedInput): Promise<RunControlResult> {
    if (this.held.size > 0) {
      const active = activeRun([...this.handles.values()].map((h) => h.state));
      const run = input.run ?? (active === undefined ? [...this.held.keys()][0] : undefined);
      if (run !== undefined && this.held.has(run)) {
        // a held run that is not active (lost, or finished): the human takes the repo as it is
        await releaseHeldRuns(this, this.held);
        const phase: Phase = this.finished.get(run)?.run.phase ?? "intake";
        return { run, paused: false, phase };
      }
    }
    const handle = this.resolve(input.run);
    return this.serial(handle, async () => {
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
      // The superseded runs are checked first: what they wrote is said before anything is taken.
      const found = await sweepDispatches(this, handle);
      if (found.issues.length === 0 && state.run.paused) {
        acceptCheckout(this);
        if (this.held.size > 0) await releaseHeldRuns(this, this.held);
        this.emit(handle, { type: "run.resumed", actor: "human", data: { auto: false } });
      }
      maybeAutoResume(this, handle);
      this.advance(handle);
      return { run: state.id, paused: state.run.paused, phase: state.run.phase };
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
