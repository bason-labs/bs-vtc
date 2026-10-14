/**
 * Run state projected from the event log (AD-7 rules 5 and 10). Pure: `applyEvent` derives every
 * engine-owned field from a core event and nothing else, so a replay of `events.jsonl` and the
 * live engine (which applies each event right after appending it) always agree. Unknown event
 * types are kept in `events` and otherwise ignored (AD-3 rule 5).
 */
import {
  HOST_IDS,
  isEventOfType,
  readEventData,
  type Escalation,
  type Feature,
  type Finding,
  type FrozenArtifact,
  type GateReport,
  type HostId,
  type IntentContract,
  type MergeLevel,
  type RoleExit,
  type Run,
  type SessionRef,
  type Task,
  type TaskStatus,
  type TokenUsage,
  type UsageSnapshot,
  type Verdict,
  type VtcEvent,
} from "@vtc/shared";

/** One role run (a `role.dispatched` and what became of it). */
export interface RoleRunRecord {
  readonly action_id: string;
  readonly seq: number;
  readonly role: string;
  readonly mode?: string;
  readonly subject?: string;
  readonly task?: string;
  readonly feature?: string;
  readonly prompt_sha: string;
  readonly host: HostId;
  readonly model: string;
  readonly dispatched_at: string;
  readonly dispatch: "subagent" | "headless";
  readonly agent: string;
  readonly pack: string;
  readonly resume: SessionRef | null;
  /** `in_flight` until a terminal event: submitted, rejected, failed, or interrupted by a limit. */
  status: "in_flight" | "submitted" | "rejected" | "failed" | "interrupted";
  /** Seq of the terminal event, when there is one. */
  closedSeq?: number;
  exit: RoleExit | null;
  verdicts: { subject: string; verdict: Verdict }[];
  head?: string;
  sessionRef: SessionRef | null;
  tokens: TokenUsage | null;
  costUsd: number | null;
  rejection?: { reason: string; issues: string[] };
}

export interface GateReportRecord {
  readonly seq: number;
  /** Parsed, with defaults applied: what the engine decides on. */
  readonly report: GateReport;
  /** The payload exactly as logged: what the read routes return. */
  readonly raw: GateReport;
}

export interface FindingRecord {
  readonly seq: number;
  finding: Finding;
}

/** The last usage-limit hit and its persisted auto-resume schedule (§6.9 steps 2–4). */
export interface LimitRecord {
  readonly seq: number;
  readonly host: HostId;
  readonly resetsAt: string | null;
  readonly autoResumeAt: string | null;
  readonly sessionRef: SessionRef | null;
  readonly pendingActionIds: readonly string[];
}

export interface MergeRecord {
  readonly seq: number;
  readonly task: string;
  readonly into: string;
  readonly commit: string;
}

export interface PushRecord {
  readonly seq: number;
  readonly feature: string;
  readonly branch: string;
  readonly commit: string;
}

export interface RunState {
  readonly id: string;
  run: Run;
  /** The run's idea or change request (`run.started.request`, redacted). */
  request: string;
  /** The configured merge level at start (`run.started.merge_level`). */
  mergeLevel: MergeLevel;
  readonly tasks: Map<string, Task>;
  readonly intents: Map<string, IntentContract>;
  /** The status a task had right before it was parked or interrupted (its checkpoint). */
  readonly checkpoints: Map<string, TaskStatus>;
  readonly features: Map<string, Feature>;
  /** Keyed by `<task or feature>:<fingerprint>`. */
  readonly findings: Map<string, FindingRecord>;
  readonly escalations: Map<string, Escalation>;
  readonly roleRuns: Map<string, RoleRunRecord>;
  readonly gateReports: GateReportRecord[];
  readonly usage: Map<HostId, UsageSnapshot>;
  limit: LimitRecord | null;
  /** Frozen interface contracts by provider task (`contract.frozen`). */
  readonly contracts: Map<string, { path: string; sha256: string }>;
  readonly merges: MergeRecord[];
  readonly pushes: PushRecord[];
  /** Change requests by escalation id. */
  readonly changeRequests: Map<
    string,
    { artifact: string; frozen: FrozenArtifact; task?: string; decided?: "approved" | "rejected" }
  >;
  /** Last `budget.updated` with scope run, if any. */
  runBudget: { budget_usd: number; spent_usd: number } | null;
  lastSeq: number;
  readonly events: VtcEvent[];
}

export const findingKey = (finding: Pick<Finding, "fingerprint" | "task" | "feature">): string =>
  `${finding.task ?? finding.feature ?? "run"}:${finding.fingerprint}`;

const pendingGate = (): Run["gates"]["G1"] => ({ status: "pending", frozen: [] });

/** A run's state before any event (only `run.started` creates a usable run). */
export const emptyRunState = (id: string, startedAt: string): RunState => ({
  id,
  run: {
    id,
    track: "feature",
    repo: "existing",
    has_ui: false,
    risk_hints: [],
    phase: "intake",
    gates: { G1: pendingGate(), G2: pendingGate() },
    paused: false,
    merge_level_effective: 2,
    started_at: startedAt,
    pipeline_config_hash: "0".repeat(64),
  },
  request: "",
  mergeLevel: 2,
  tasks: new Map(),
  intents: new Map(),
  checkpoints: new Map(),
  features: new Map(),
  findings: new Map(),
  escalations: new Map(),
  roleRuns: new Map(),
  gateReports: [],
  usage: new Map(),
  limit: null,
  contracts: new Map(),
  merges: [],
  pushes: [],
  changeRequests: new Map(),
  runBudget: null,
  lastSeq: 0,
  events: [],
});

const refreeze = (state: RunState, path: string, sha256: string): void => {
  for (const gate of [state.run.gates.G1, state.run.gates.G2]) {
    gate.frozen = gate.frozen.map((f) => (f.path === path ? { path, sha256 } : f));
  }
};

const updateTask = (state: RunState, id: string | undefined, patch: (task: Task) => Task): void => {
  if (id === undefined) return;
  const task = state.tasks.get(id);
  if (task !== undefined) state.tasks.set(id, patch(task));
};

const updateFeature = (
  state: RunState,
  id: string | undefined,
  patch: (feature: Feature) => Feature,
): void => {
  if (id === undefined) return;
  const feature = state.features.get(id);
  if (feature !== undefined) state.features.set(id, patch(feature));
};

/** Applies one event in place. Events must arrive in `seq` order. */
export const applyEvent = (state: RunState, event: VtcEvent): void => {
  state.events.push(event);
  state.lastSeq = Math.max(state.lastSeq, event.seq);
  if (isEventOfType(event, "run.started")) {
    const data = readEventData(event);
    state.run = {
      ...state.run,
      track: data.track,
      repo: data.repo,
      has_ui: data.has_ui,
      risk_hints: data.risk_hints,
      phase: "intake",
      merge_level_effective: data.merge_level,
      started_at: event.ts,
      pipeline_config_hash: data.pipeline_config_hash,
    };
    state.request = data.request;
    state.mergeLevel = data.merge_level;
  } else if (isEventOfType(event, "run.phase_changed")) {
    state.run.phase = readEventData(event).to;
  } else if (isEventOfType(event, "run.paused")) {
    state.run.paused = true;
  } else if (isEventOfType(event, "run.resumed")) {
    state.run.paused = false;
    if (readEventData(event).auto && state.limit !== null) {
      state.limit = { ...state.limit, autoResumeAt: null };
    }
  } else if (isEventOfType(event, "run.finished")) {
    state.run.finished_at = event.ts;
  } else if (isEventOfType(event, "run.merge_level_changed")) {
    state.run.merge_level_effective = readEventData(event).to;
  } else if (isEventOfType(event, "gate.approved")) {
    const data = readEventData(event);
    for (const gate of data.gates) {
      state.run.gates[gate] = { status: "approved", frozen: data.frozen, decided_at: event.ts };
    }
  } else if (isEventOfType(event, "gate.rejected")) {
    for (const gate of readEventData(event).gates) {
      state.run.gates[gate] = { status: "rejected", frozen: [], decided_at: event.ts };
    }
  } else if (isEventOfType(event, "task.created")) {
    const data = readEventData(event);
    state.tasks.set(data.task.id, data.task);
    if (data.intent !== undefined) state.intents.set(data.task.id, data.intent);
  } else if (isEventOfType(event, "task.status_changed")) {
    const data = readEventData(event);
    if (data.to === "parked" || data.to === "interrupted") {
      if (event.task !== undefined) state.checkpoints.set(event.task, data.from);
    }
    updateTask(state, event.task, (task) => {
      const { park_reason: _p, risk_rule: _r, ...rest } = task;
      return {
        ...rest,
        status: data.to,
        round: data.round,
        cap: data.cap,
        ...(data.park_reason === undefined ? {} : { park_reason: data.park_reason }),
        ...(data.risk_rule === undefined ? {} : { risk_rule: data.risk_rule }),
      };
    });
  } else if (isEventOfType(event, "task.workspace_assigned")) {
    const data = readEventData(event);
    updateTask(state, event.task, (task) => ({
      ...task,
      worktree: data.worktree,
      branch: data.branch,
      baseline_revision: data.baseline_revision,
    }));
  } else if (isEventOfType(event, "task.session_updated")) {
    const data = readEventData(event);
    updateTask(state, event.task, (task) => ({ ...task, session_ref: data.session_ref }));
  } else if (isEventOfType(event, "contract.frozen")) {
    const data = readEventData(event);
    if (event.task !== undefined) state.contracts.set(event.task, data);
    updateTask(state, event.task, (task) =>
      task.provides_contract === undefined
        ? task
        : { ...task, provides_contract: { ...task.provides_contract, frozen_sha256: data.sha256 } },
    );
  } else if (isEventOfType(event, "feature.created")) {
    const { feature } = readEventData(event);
    state.features.set(feature.id, feature);
  } else if (isEventOfType(event, "feature.task_added")) {
    const { task } = readEventData(event);
    updateFeature(state, event.feature, (f) =>
      f.tasks.includes(task) ? f : { ...f, tasks: [...f.tasks, task] },
    );
  } else if (isEventOfType(event, "feature.status_changed")) {
    const data = readEventData(event);
    updateFeature(state, event.feature, (f) => {
      const { park_reason: _p, risk_rule: _r, ...rest } = f;
      return {
        ...rest,
        status: data.to,
        round: data.round,
        ...(data.park_reason === undefined ? {} : { park_reason: data.park_reason }),
        ...(data.risk_rule === undefined ? {} : { risk_rule: data.risk_rule }),
      };
    });
  } else if (isEventOfType(event, "feature.pr_updated")) {
    const { pr } = readEventData(event);
    updateFeature(state, event.feature, (f) => ({ ...f, pr }));
  } else if (isEventOfType(event, "branch.pushed")) {
    const data = readEventData(event);
    if (event.feature !== undefined) {
      state.pushes.push({
        seq: event.seq,
        feature: event.feature,
        branch: data.branch,
        commit: data.commit,
      });
    }
  } else if (isEventOfType(event, "role.dispatched")) {
    const data = readEventData(event);
    state.roleRuns.set(data.action_id, {
      action_id: data.action_id,
      seq: event.seq,
      role: event.role ?? "unknown",
      ...(data.mode === undefined ? {} : { mode: data.mode }),
      ...(data.subject === undefined ? {} : { subject: data.subject }),
      ...(event.task === undefined ? {} : { task: event.task }),
      ...(event.feature === undefined ? {} : { feature: event.feature }),
      prompt_sha: event.prompt_sha ?? "",
      host: event.host ?? (HOST_IDS[0] as HostId),
      model: event.model ?? "unknown",
      dispatched_at: event.ts,
      dispatch: data.dispatch,
      agent: data.agent,
      pack: data.pack,
      resume: data.resume,
      status: "in_flight",
      exit: null,
      verdicts: [],
      sessionRef: null,
      tokens: null,
      costUsd: null,
    });
  } else if (isEventOfType(event, "role.submitted")) {
    const data = readEventData(event);
    const run = state.roleRuns.get(data.action_id);
    if (run !== undefined) {
      run.status = "submitted";
      run.closedSeq = event.seq;
      run.exit = data.exit;
      run.verdicts = data.verdicts;
      if (data.head !== undefined) run.head = data.head;
      run.sessionRef = data.session_ref;
      run.tokens = event.tokens ?? null;
      run.costUsd = event.cost_usd ?? null;
    }
  } else if (isEventOfType(event, "role.rejected")) {
    const data = readEventData(event);
    const run = state.roleRuns.get(data.action_id);
    if (run?.status === "in_flight") {
      run.status = "rejected";
      run.closedSeq = event.seq;
      run.rejection = { reason: data.reason, issues: data.issues };
      run.tokens = event.tokens ?? null;
      run.costUsd = event.cost_usd ?? null;
    }
  } else if (isEventOfType(event, "role.failed")) {
    const data = readEventData(event);
    const run = state.roleRuns.get(data.action_id);
    if (run?.status === "in_flight") {
      run.status = "failed";
      run.closedSeq = event.seq;
      run.costUsd = event.cost_usd ?? null;
    }
  } else if (isEventOfType(event, "gate.result")) {
    state.gateReports.push({
      seq: event.seq,
      report: readEventData(event),
      raw: event.data as unknown as GateReport,
    });
  } else if (isEventOfType(event, "finding.recorded")) {
    const { finding } = readEventData(event);
    state.findings.set(findingKey(finding), { seq: event.seq, finding });
    if (finding.route === "defer" && finding.task !== undefined) {
      updateTask(state, finding.task, (task) =>
        task.deferred.includes(finding.fingerprint)
          ? task
          : { ...task, deferred: [...task.deferred, finding.fingerprint] },
      );
    }
  } else if (isEventOfType(event, "finding.status_changed")) {
    const data = readEventData(event);
    const scope = event.task ?? event.feature ?? "run";
    const record = state.findings.get(`${scope}:${data.fingerprint}`);
    if (record !== undefined) {
      const { waiver: _w, ...rest } = record.finding;
      record.finding = {
        ...rest,
        status: data.to,
        ...(data.waiver === undefined ? {} : { waiver: data.waiver }),
      };
    }
  } else if (isEventOfType(event, "escalation.opened")) {
    const { escalation } = readEventData(event);
    state.escalations.set(escalation.id, escalation);
  } else if (isEventOfType(event, "escalation.answered")) {
    const data = readEventData(event);
    const escalation = state.escalations.get(data.escalation);
    if (escalation !== undefined) {
      state.escalations.set(data.escalation, {
        ...escalation,
        answer: data.answer,
        answered_at: event.ts,
      });
    }
  } else if (isEventOfType(event, "change_request.opened")) {
    const data = readEventData(event);
    state.changeRequests.set(data.escalation, {
      artifact: data.artifact,
      frozen: data.frozen,
      ...(data.task === undefined ? {} : { task: data.task }),
    });
  } else if (isEventOfType(event, "change_request.decided")) {
    const data = readEventData(event);
    const cr = state.changeRequests.get(data.escalation);
    if (cr !== undefined) cr.decided = data.decision;
    if (data.new_sha256 !== undefined) refreeze(state, data.frozen.path, data.new_sha256);
  } else if (isEventOfType(event, "spec.clarified")) {
    const data = readEventData(event);
    refreeze(state, data.path, data.new_sha256);
  } else if (isEventOfType(event, "budget.updated")) {
    const data = readEventData(event);
    if (data.scope === "task") {
      updateTask(state, event.task, (task) => ({
        ...task,
        budget_usd: data.budget_usd,
        spent_usd: data.spent_usd,
      }));
    } else if (data.scope === "feature") {
      updateFeature(state, event.feature, (f) => ({
        ...f,
        budget_usd: data.budget_usd,
        spent_usd: data.spent_usd,
      }));
    } else {
      state.runBudget = { budget_usd: data.budget_usd, spent_usd: data.spent_usd };
    }
  } else if (isEventOfType(event, "usage.updated")) {
    const { snapshot } = readEventData(event);
    state.usage.set(snapshot.host, snapshot);
  } else if (isEventOfType(event, "limit.hit")) {
    const data = readEventData(event);
    state.limit = {
      seq: event.seq,
      host: data.host,
      resetsAt: data.resets_at,
      autoResumeAt: data.auto_resume_at,
      sessionRef: data.session_ref,
      pendingActionIds: data.pending_action_ids,
    };
    for (const id of data.pending_action_ids) {
      const run = state.roleRuns.get(id);
      if (run?.status === "in_flight") {
        run.status = "interrupted";
        run.closedSeq = event.seq;
        // the cost the host reported before the limit (D-at), on the hit that closed the run
        if (event.cost_usd !== undefined) run.costUsd = event.cost_usd;
      }
    }
  } else if (isEventOfType(event, "merge.completed")) {
    const data = readEventData(event);
    if (event.task !== undefined) {
      state.merges.push({ seq: event.seq, task: event.task, into: data.into, commit: data.commit });
    }
  }
};

/** Replays a run's events (in `seq` order) into its state. */
export const projectRun = (events: readonly VtcEvent[]): RunState => {
  const first = events[0];
  if (first === undefined) throw new RangeError("a run needs at least one event");
  const state = emptyRunState(first.run, first.ts);
  for (const event of [...events].sort((a, b) => a.seq - b.seq)) applyEvent(state, event);
  return state;
};
