/**
 * Read models (AD-5 rule 4): the response of every read route and of the `status` and
 * `escalations` tools, built from a {@link RunState} only. Live mode and snapshot mode use the
 * same functions, so the dashboard sees the same shapes either way (AD-5 rule 7).
 */
import {
  EVENT_PAGE_LIMIT,
  HOST_IDS,
  unknownUsage,
  type Escalation,
  type EscalationList,
  type EventPage,
  type FeatureList,
  type HostId,
  type RunList,
  type StatusResult,
  type TaskDetail,
  type TaskList,
  type TaskStatus,
  type UsageReport,
  type UsageSnapshot,
} from "@vtc/shared";
import type { RunState } from "./state.js";

/** `.vtc/tasks/T-n.md` (§4.3, AD-7 rule 8). */
export const planFilePath = (task: string): string => `.vtc/tasks/${task}.md`;

/** Escalations not answered yet, in the order they were opened. */
export const openEscalations = (state: RunState): Escalation[] =>
  [...state.escalations.values()].filter((e) => e.answer === undefined);

/**
 * The usage panel (§17): the latest snapshot per host (unknown, never 0%, when there is none),
 * the tasks interrupted by limits and the next auto-resume time.
 */
export const usageReportView = (
  usage: ReadonlyMap<HostId, UsageSnapshot>,
  state: RunState | null,
): UsageReport => {
  const interrupted =
    state === null
      ? []
      : [...state.tasks.values()].filter((t) => t.status === "interrupted").map((t) => t.id);
  return {
    hosts: HOST_IDS.map((host) => usage.get(host) ?? unknownUsage(host)),
    interrupted_tasks: interrupted,
    auto_resume_at: interrupted.length > 0 ? (state?.limit?.autoResumeAt ?? null) : null,
  };
};

/**
 * The run's budget and spend (§11). The spend is every role run's host-reported cost: the front
 * half's (Cartographer, BA, Architect, Planner, before any feature exists), advisors', and
 * rejected and failed runs' too, so the run never shows less than it spent. Unpriced runs count
 * as 0 here (the summary flags them).
 */
const runBudget = (state: RunState): StatusResult["budget"] => {
  const features = [...state.features.values()];
  const sum = (pick: (f: (typeof features)[number]) => number): number =>
    features.reduce((total, f) => total + pick(f), 0);
  const roleRuns = [...state.roleRuns.values()].reduce((total, r) => total + (r.costUsd ?? 0), 0);
  const recorded = state.runBudget?.spent_usd ?? sum((f) => f.spent_usd);
  return {
    budget_usd: state.runBudget?.budget_usd ?? sum((f) => f.budget_usd),
    spent_usd: Math.round(Math.max(roleRuns, recorded) * 1e6) / 1e6,
  };
};

export const statusView = (
  state: RunState,
  usage: ReadonlyMap<HostId, UsageSnapshot>,
): StatusResult => {
  const counts: Partial<Record<TaskStatus, number>> = {};
  for (const task of state.tasks.values()) counts[task.status] = (counts[task.status] ?? 0) + 1;
  return {
    run: state.run,
    tasks_by_status: counts,
    parked: [...state.tasks.values()].flatMap((t) =>
      t.status === "parked" && t.park_reason !== undefined
        ? [
            {
              task: t.id,
              reason: t.park_reason,
              ...(t.risk_rule === undefined ? {} : { risk_rule: t.risk_rule }),
            },
          ]
        : [],
    ),
    features: [...state.features.values()],
    open_escalations: openEscalations(state).length,
    budget: runBudget(state),
    usage: usageReportView(usage, state),
  };
};

export const runListView = (states: readonly RunState[]): RunList => ({
  runs: states.map((s) => ({
    id: s.run.id,
    track: s.run.track,
    phase: s.run.phase,
    paused: s.run.paused,
    started_at: s.run.started_at,
    ...(s.run.finished_at === undefined ? {} : { finished_at: s.run.finished_at }),
  })),
});

export const taskListView = (state: RunState): TaskList => ({
  run: state.id,
  tasks: [...state.tasks.values()],
});

export const featureListView = (state: RunState): FeatureList => ({
  run: state.id,
  features: [...state.features.values()],
});

export const escalationListView = (state: RunState): EscalationList => ({
  run: state.id,
  escalations: openEscalations(state),
});

/** One page of the log after `after` (exclusive); `next_after` is null at the end. */
export const eventPageView = (state: RunState, after: number, limit: number): EventPage => {
  const size = Math.min(Math.max(1, limit), EVENT_PAGE_LIMIT.max);
  const rest = state.events.filter((e) => e.seq > after);
  const events = rest.slice(0, size);
  const last = events.at(-1);
  return {
    run: state.id,
    events,
    next_after: rest.length > size && last !== undefined ? last.seq : null,
  };
};

export interface TaskDetailOptions {
  /** True when `.vtc/evidence/T-n/bundle.json` exists (written by engine core, AD-18 rule 4). */
  readonly evidenceBundle?: string | null;
}

/** The drill-down of one task (§17); `null` when the run has no such task. */
export const taskDetailView = (
  state: RunState,
  taskId: string,
  options: TaskDetailOptions = {},
): TaskDetail | null => {
  const task = state.tasks.get(taskId);
  if (task === undefined) return null;
  const records = state.gateReports.filter((r) => r.report.task === taskId);
  const reports = records.map((r) => r.report);
  const last = reports.filter((r) => r.reason === "round" || r.reason === "merge_queue").at(-1);
  return {
    run: state.id,
    task,
    plan_file: planFilePath(taskId),
    findings: [...state.findings.values()]
      .filter((r) => r.finding.task === taskId)
      .map((r) => r.finding),
    gate_reports: records.map((r) => r.raw),
    escalations: [...state.escalations.values()].filter((e) => e.task === taskId),
    role_runs: [...state.roleRuns.values()]
      .filter((r) => r.task === taskId)
      .map((r) => ({
        action_id: r.action_id,
        role: r.role,
        ...(r.mode === undefined ? {} : { mode: r.mode }),
        ...(r.subject === undefined ? {} : { subject: r.subject }),
        prompt_sha: r.prompt_sha,
        host: r.host,
        model: r.model,
        dispatched_at: r.dispatched_at,
        exit: r.exit,
        verdicts: r.verdicts,
      })),
    diff: last === undefined ? null : { base: last.base, head: last.head },
    evidence_bundle: options.evidenceBundle ?? null,
  };
};
