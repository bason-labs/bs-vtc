/** Pure queries over a run's projected state, shared by the engine's modules. */
import type { Finding, Phase, Task } from "@vtc/shared";
import type { RoleRunRecord, RunState } from "./state.js";

export const nextActionId = (state: RunState): string => `a-${String(state.roleRuns.size + 1)}`;

export const nextEscalationId = (state: RunState): string => `E-${String(state.escalations.size + 1)}`;

export const inFlight = (state: RunState): RoleRunRecord[] =>
  [...state.roleRuns.values()].filter((r) => r.status === "in_flight");

export const runsOf = (state: RunState, task: string): RoleRunRecord[] =>
  [...state.roleRuns.values()].filter((r) => r.task === task);

/** Seq of the last time the run entered `phase`, or `null`. */
export const phaseEnteredSeq = (state: RunState, phase: Phase): number | null => {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const e = state.events[i];
    if (e?.type === "run.phase_changed" && (e.data as { to?: string }).to === phase) return e.seq;
  }
  return null;
};

/** Seq of the last status change of a task to `status`, or `null`. */
export const statusEnteredSeq = (state: RunState, task: string, status: string): number | null => {
  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const e = state.events[i];
    if (e?.task === task && e.type === "task.status_changed" && (e.data as { to?: string }).to === status) {
      return e.seq;
    }
  }
  return null;
};

/** The last accepted run of a role (and mode) after `afterSeq`. */
export const lastSubmitted = (
  state: RunState,
  filter: { role: string; mode?: string; task?: string; subject?: string },
  afterSeq = 0,
): RoleRunRecord | undefined =>
  [...state.roleRuns.values()]
    .filter(
      (r) =>
        r.status === "submitted" &&
        r.role === filter.role &&
        r.mode === filter.mode &&
        r.task === filter.task &&
        (filter.subject === undefined || r.subject === filter.subject) &&
        (r.closedSeq ?? 0) > afterSeq,
    )
    .at(-1);

/** The Engineer's last built submission of a task: its head is what the gates verify. */
export const lastBuilt = (state: RunState, task: string): RoleRunRecord | undefined =>
  runsOf(state, task)
    .filter((r) => r.role === "engineer" && r.status === "submitted" && r.exit === "built")
    .at(-1);

/** QA author's last accepted submission of a task (its head holds the acceptance tests). */
export const lastQaAuthor = (state: RunState, task: string): RoleRunRecord | undefined =>
  runsOf(state, task)
    .filter((r) => r.role === "qa" && r.mode === "author" && r.status === "submitted")
    .at(-1);

export const taskFindings = (state: RunState, task: string): Finding[] =>
  [...state.findings.values()].filter((r) => r.finding.task === task).map((r) => r.finding);

/** Runs of one step that ended without an accepted result since its last accepted one. */
export const consecutiveFailures = (
  state: RunState,
  step: { role: string; mode?: string; task?: string; subject?: string },
): number => {
  const runs = [...state.roleRuns.values()].filter(
    (r) => r.role === step.role && r.mode === step.mode && r.task === step.task && r.subject === step.subject,
  );
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const r = runs[i];
    if (r === undefined || r.status === "submitted") break;
    if (r.status === "rejected" || r.status === "failed") count += 1;
  }
  return count;
};

/** Every task id used by any run of the repo (plan files are repo-wide). */
export const usedTaskIds = (states: Iterable<RunState>): Set<string> => {
  const ids = new Set<string>();
  for (const s of states) for (const id of s.tasks.keys()) ids.add(id);
  return ids;
};

export const usedFeatureIds = (states: Iterable<RunState>): Set<string> => {
  const ids = new Set<string>();
  for (const s of states) for (const id of s.features.keys()) ids.add(id);
  return ids;
};

export const nextNumberedId = (prefix: "T" | "F", used: ReadonlySet<string>): string => {
  let max = 0;
  for (const id of used) {
    const n = Number(id.slice(prefix.length + 1));
    if (id.startsWith(`${prefix}-`) && Number.isInteger(n)) max = Math.max(max, n);
  }
  return `${prefix}-${String(max + 1)}`;
};

/** Plan order: creation order of the tasks. */
export const planOrder = (state: RunState): Task[] => [...state.tasks.values()];

export const featureOf = (state: RunState, task: Task) => state.features.get(task.feature);
