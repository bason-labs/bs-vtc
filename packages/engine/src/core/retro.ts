/**
 * RETRO (§6.1; spec §13 steps 1–2; spine AD-21 rules 4 and 8, §5 reading 154): after the release,
 * before `run.finished`, the engine asks the wired Lookback (`LookbackRetro`) which (role, host)
 * prompt versions failed often enough to get the lookback role, and runs that role once per target,
 * in order, like any task-less role (its own worktree; in-session or headless as `planDispatch`
 * says). The role reads the Markdown the engine wrote for its target and writes a proposal only;
 * the engine checks it on submit (a refused one is a rejection the role may answer, three failures
 * skip the target) and stores an accepted one as a candidate version. The run finishes once every
 * target is settled. Lookback never holds a delivered feature: with no Lookback wired, or when its
 * planning fails, the run finishes at once.
 * Replays (AD-21 rule 6) are not wired: spine §7 "Lookback replays".
 */
import { writeRepoFile } from "../git/index.js";
import type { LookbackTargetRef, Kernel, RunHandle } from "./kernel.js";
import { phaseEnteredSeq, countsAsFailure } from "./queries.js";
import type { RoleRunRecord } from "./state.js";
import type { StepSpec } from "./dispatch.js";
import { writeRunSummary } from "./projections.js";
import { taskDetailView } from "./views.js";

/** The role the RETRO step dispatches. */
export const LOOKBACK_ROLE = "lookback";

/** After this many failed or rejected lookback runs a target is skipped (`MAX_STEP_FAILURES`). */
const RETRO_MAX_FAILURES = 3;

/** `.vtc/runs/<run>/lookback-<n>.md`: what the lookback role reads for the n-th target. */
export const lookbackInputPath = (run: string, n: number): string =>
  `.vtc/runs/${run}/lookback-${String(n)}.md`;

export interface RetroTarget extends LookbackTargetRef {
  /** 1-based, in `lookback.dispatched` order. */
  readonly n: number;
  readonly input: string;
  /** Done: proposed (or found nothing to fix), or skipped after three failures. */
  readonly settled: boolean;
  /** A lookback run of this target in flight. */
  readonly running: boolean;
  /** The lookback runs that worked on it, oldest first. */
  readonly runs: readonly RoleRunRecord[];
}

const retroEntered = (h: RunHandle): number | undefined =>
  h.state.run.phase === "retro" ? (phaseEnteredSeq(h.state, "retro") ?? 0) : undefined;

/**
 * The RETRO queue: one target per `lookback.dispatched` since RETRO began, each holding the
 * lookback runs dispatched for it (the runs go to the targets in order, since one runs at a time).
 */
export const retroQueue = (h: RunHandle): RetroTarget[] => {
  const since = retroEntered(h);
  if (since === undefined) return [];
  const dispatched = h.state.events.filter(
    (e) => e.seq > since && e.type === "lookback.dispatched",
  );
  const runs = [...h.state.roleRuns.values()]
    .filter((r) => r.role === LOOKBACK_ROLE && r.task === undefined && r.seq > since)
    .sort((a, b) => a.seq - b.seq);
  let next = 0;
  return dispatched.map((e, i) => {
    const data = e.data as { target_role: string; target_mode?: string; target_host: string };
    const mine: RoleRunRecord[] = [];
    let settled = false;
    let running = false;
    let failures = 0;
    while (next < runs.length) {
      const run = runs[next] as RoleRunRecord;
      next += 1;
      mine.push(run);
      if (run.status === "in_flight") {
        running = true;
        break;
      }
      if (run.status === "submitted") {
        settled = true;
        break;
      }
      if (countsAsFailure(run)) failures += 1;
      if (failures >= RETRO_MAX_FAILURES) {
        settled = true;
        break;
      }
    }
    return {
      n: i + 1,
      role: data.target_role,
      ...(data.target_mode === undefined ? {} : { mode: data.target_mode }),
      host: data.target_host as LookbackTargetRef["host"],
      input: lookbackInputPath(h.state.id, i + 1),
      settled,
      running,
      runs: mine,
    };
  });
};

/** The target a lookback run worked on. */
export const retroTargetOf = (h: RunHandle, action: string): RetroTarget | undefined =>
  retroQueue(h).find((t) => t.runs.some((r) => r.action_id === action));

/** The lookback role step RETRO wants now: the first unsettled target, when none is running. */
export const retroSteps = (h: RunHandle): StepSpec[] => {
  const queue = retroQueue(h);
  if (queue.some((t) => t.running)) return [];
  const target = queue.find((t) => !t.settled);
  if (target === undefined) return [];
  const rejected = target.runs.findLast((r) => r.status === "rejected")?.rejection;
  const name = `${target.role}${target.mode === undefined ? "" : ` (${target.mode})`} on ${target.host}`;
  return [
    {
      key: `retro:lookback:${String(target.n)}`,
      role: LOOKBACK_ROLE,
      inputs: [{ type: "traces", path: target.input }],
      note: [
        `Lookback (§13 steps 1–2): propose at most three changes to the editable section of ${name}. Read ${target.input}: the version under review, its train traces and the human edits.`,
        ...(rejected === undefined
          ? []
          : [
              `Your previous proposal was refused (${rejected.reason}): ${rejected.issues.join("; ")}`,
            ]),
      ].join("\n"),
    },
  ];
};

/** RETRO's last step: the run summary, then `run.finished` (callers hold the run's lock). */
export const finishRun = (k: Kernel, h: RunHandle): void => {
  if (h.state.run.finished_at !== undefined) return;
  if (h.state.run.phase !== "retro")
    k.emit(h, {
      type: "run.phase_changed",
      actor: "engine",
      data: { from: h.state.run.phase, to: "retro" },
    });
  const roleRuns = [...h.state.tasks.keys()].flatMap(
    (t) => taskDetailView(h.state, t)?.role_runs ?? [],
  );
  const summary = writeRunSummary(k.deps.repoRoot, h.state, roleRuns, k.secrets());
  k.emit(h, { type: "run.finished", actor: "engine", data: { outcome: "done", summary } });
};

/** Why the RETRO plan job is wanted: RETRO began and no target was queued yet. */
const planned = (h: RunHandle): boolean => {
  const since = retroEntered(h);
  return (
    since !== undefined &&
    h.state.events.some((e) => e.seq > since && e.type === "lookback.dispatched")
  );
};

/**
 * Plans RETRO (a job; callers hold the run's lock): the wired Lookback's targets, each with the
 * Markdown its lookback run reads and its `lookback.dispatched`. No target, no Lookback, or a plan
 * that fails: the run finishes at once (a failed plan is a notice, never the run's failure).
 */
export const startRetro = (k: Kernel, h: RunHandle): void => {
  const lookback = k.lookbackRetro();
  if (lookback === null) {
    finishRun(k, h);
    return;
  }
  if (planned(h) || k.isRunning(`retro:${h.state.id}`)) return;
  k.spawn(h, `retro:${h.state.id}`, async () => {
    let targets: Awaited<ReturnType<typeof lookback.plan>>["targets"] = [];
    let problem: string | undefined;
    try {
      ({ targets } = await lookback.plan(h.state));
    } catch (error) {
      problem = error instanceof Error ? error.message : String(error);
    }
    await k.serial(h, () => {
      if (h.state.run.finished_at !== undefined || planned(h)) return Promise.resolve();
      if (problem !== undefined) k.notice(`lookback at the end of run ${h.state.id}: ${problem}`);
      targets.forEach((target, i) => {
        writeRepoFile(k.deps.repoRoot, lookbackInputPath(h.state.id, i + 1), target.input);
        k.emit(h, target.dispatched);
      });
      if (targets.length === 0) finishRun(k, h);
      return Promise.resolve();
    });
  });
};

const finished = (h: RunHandle): boolean => h.state.run.finished_at !== undefined;

/**
 * RETRO's progress (callers hold the run's lock): plan when nothing is queued yet, finish once
 * every target is settled and no lookback run is in flight. Returns whether the run changed.
 */
export const stepRetro = (k: Kernel, h: RunHandle): boolean => {
  if (h.state.run.phase !== "retro" || h.state.run.finished_at !== undefined) return false;
  if (!planned(h)) {
    startRetro(k, h);
    // the plan may have finished the run at once (no Lookback wired)
    return finished(h);
  }
  const queue = retroQueue(h);
  if (queue.every((t) => t.settled) && !queue.some((t) => t.running)) {
    finishRun(k, h);
    return true;
  }
  return false;
};
