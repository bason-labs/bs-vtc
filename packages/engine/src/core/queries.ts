/** Pure queries over a run's projected state, shared by the engine's modules. */
import type { ArtifactRef, Finding, GateReport, Phase, Task } from "@vtc/shared";
import type { RoleRunRecord, RunState } from "./state.js";

export const nextActionId = (state: RunState): string => `a-${String(state.roleRuns.size + 1)}`;

export const nextEscalationId = (state: RunState): string =>
  `E-${String(state.escalations.size + 1)}`;

export const inFlight = (state: RunState): RoleRunRecord[] =>
  [...state.roleRuns.values()].filter((r) => r.status === "in_flight");

export const runsOf = (state: RunState, task: string): RoleRunRecord[] =>
  [...state.roleRuns.values()].filter((r) => r.task === task);

/** A reviewer run (§6.3 step 7): Spec-Verifier, Visual QA, QA judge, Security verify. */
export const isReviewer = (run: Pick<RoleRunRecord, "role" | "mode">): boolean =>
  run.role === "spec_verifier" ||
  run.role.startsWith("lens_") ||
  run.role === "visual_qa" ||
  (run.role === "qa" && run.mode === "judge") ||
  (run.role === "security" && run.mode === "verify");

/** Priced spend of a task's Engineer and reviewer runs (§11 shares within a task). */
export const shareSpend = (
  state: RunState,
  task: string,
): { readonly engineer: number; readonly reviewers: number } => {
  let engineer = 0;
  let reviewers = 0;
  for (const run of runsOf(state, task)) {
    const cost = run.costUsd ?? 0;
    if (run.role === "engineer") engineer += cost;
    else if (isReviewer(run)) reviewers += cost;
  }
  return { engineer, reviewers };
};

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
    if (
      e?.task === task &&
      e.type === "task.status_changed" &&
      (e.data as { to?: string }).to === status
    ) {
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

/**
 * A rejected or failed run, unless the engine or the human stopped it (`vtc pause`, a resume):
 * what the stuck limits count.
 */
export const countsAsFailure = (run: RoleRunRecord): boolean =>
  run.status === "rejected" || (run.status === "failed" && run.stopped !== true);

/**
 * Runs of one step that ended without an accepted result since its last accepted one (a stopped
 * run neither counts nor breaks the streak).
 */
export const consecutiveFailures = (
  state: RunState,
  step: { role: string; mode?: string; task?: string; subject?: string },
): number => {
  const runs = [...state.roleRuns.values()].filter(
    (r) =>
      r.role === step.role &&
      r.mode === step.mode &&
      r.task === step.task &&
      r.subject === step.subject,
  );
  let count = 0;
  for (let i = runs.length - 1; i >= 0; i -= 1) {
    const r = runs[i];
    if (r === undefined || r.status === "submitted") break;
    if (countsAsFailure(r)) count += 1;
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

/**
 * The gate report that concluded the task's current verification: a `round` report for its built
 * head with a verdict other than `infra_error`, logged after the task last entered `verifying`.
 */
export const roundVerdict = (state: RunState, task: string): GateReport | undefined => {
  const head = lastBuilt(state, task)?.head;
  const since = statusEnteredSeq(state, task, "verifying") ?? 0;
  return state.gateReports
    .filter(
      (r) =>
        r.seq > since &&
        r.report.task === task &&
        r.report.reason === "round" &&
        r.report.head === head &&
        r.report.verdict !== "infra_error",
    )
    .at(-1)?.report;
};

/**
 * A task Final Review reopened (`merged` → `fixing`, spine §5 reading 150) whose preserved
 * worktree has not yet been moved onto the integrated head: its last reopen is newer than its last
 * `task.workspace_assigned`. No role runs in it until the engine rebased it (`rebaseReopened`).
 */
export const awaitingReopenRebase = (state: RunState, task: string): boolean => {
  let reopened = 0;
  let assigned = 0;
  for (const e of state.events) {
    if (e.task !== task) continue;
    if (e.type === "task.workspace_assigned") assigned = e.seq;
    else if (
      e.type === "task.status_changed" &&
      (e.data as { from?: string; to?: string }).from === "merged" &&
      (e.data as { to?: string }).to === "fixing"
    )
      reopened = e.seq;
  }
  return reopened > assigned;
};

/**
 * The visual report a Visual QA judge reads (§7.5 step 6, spine §5 reading 92): the path the
 * gate run's visual step wrote, when that step rendered screens and passed its deterministic
 * checks. `undefined` when it did not run, was skipped (no browser, D-ay) or rendered nothing:
 * a judge with no renders could only answer `unchecked`.
 */
export const renderedVisualReport = (
  report: Pick<GateReport, "visual"> | undefined,
): string | undefined => {
  const visual = report?.visual;
  return visual?.status === "pass" && visual.report !== null && visual.counts.renders > 0
    ? visual.report
    : undefined;
};

/**
 * What a Visual QA judge dispatch carries (§7.5 step 6): the visual report and the directory of
 * its render evidence (screenshots, the prototype renders, diff images) as pack inputs, and a note
 * naming them. `what` says what is judged ("task T-1's screens", "feature F-1's user journeys").
 */
export const visualJudgeStep = (
  report: string,
  what: string,
): { readonly inputs: ArtifactRef[]; readonly note: string } => {
  const dir = report.includes("/") ? report.slice(0, report.lastIndexOf("/")) : report;
  return {
    inputs: [
      { type: "visual_report", path: report },
      { type: "screenshots", path: dir },
    ],
    note: `Judge ${what} on V1–V8 from the deterministic visual step's report ${report} and its renders under ${dir}: read the report first; a route or state it lists as not rendered is unchecked for the criteria it affects.`,
  };
};

/**
 * QA's tests waiting for their base-fail check: QA submitted since the task became ready and no
 * conclusive `base_fail_check` report followed. Returns that run.
 */
export const pendingBaseCheck = (state: RunState, task: string): RoleRunRecord | undefined => {
  const qa = lastQaAuthor(state, task);
  const since = statusEnteredSeq(state, task, "ready") ?? 0;
  if (qa === undefined || (qa.closedSeq ?? 0) < since || qa.head === undefined) return undefined;
  const checked = state.gateReports.some(
    (r) =>
      r.seq > (qa.closedSeq ?? 0) &&
      r.report.task === task &&
      r.report.reason === "base_fail_check" &&
      r.report.verdict !== "infra_error",
  );
  return checked ? undefined : qa;
};
