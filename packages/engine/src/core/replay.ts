/**
 * Lookback replays at RETRO (spec §13 step 3; AD-21 rule 6; spine §5 reading 176). Once every
 * lookback target of the run is settled, RETRO asks the wired Lookback for the replays it may run
 * now (`LookbackRetro.replays`: one per proposal recorded and not yet replayed, under the same
 * weekly-window and budget checks as the lookback role) and runs their `lookback_replay` trials
 * one at a time, like any task-less role (`planDispatch`, in-session or headless):
 * - each trial is a recorded dispatch run again with one arm's prompt version, in a clean checkout
 *   at the commit that dispatch started from, with no refs past it (`createReplayCheckout`), at
 *   the path a task-less role's worktree has, so the write-scope hook and the headless sandbox
 *   apply as for any role; the pack is the recorded one, without its task (a trial changes no
 *   task), with the arm's editable section first;
 * - its result is checked against the role's contract, its work committed in the checkout and
 *   graded through the Gate Runner (`LookbackRetro.gradeTrial`); a rejected, failed or
 *   interrupted trial did not pass. Nothing a trial does reaches a task, the user's checkout or
 *   the integration branch;
 * - once every trial of a replay is graded, Lookback writes its result
 *   (`LookbackRetro.finishReplay`: `ReplayResult`, `lookback.replay_finished` with the SHA-256).
 * A replay whose host is not the run's Lead host, or that no dispatch can run now, waits: it stays
 * pending, and the next RETRO plans it again. The plan, the trial dispatches and their grades live
 * in the engine's private directory (`<guard>/replays/`), where no role can write, so a restart
 * picks the replays up where they stopped.
 */
import { join } from "node:path";
import {
  agentNameFor,
  GateRunRequestSchema,
  planDispatch,
  type GateRunRequest,
  type HostId,
  type TaskPack,
} from "@vtc/shared";
import {
  createReplayCheckout,
  removeReplayCheckout,
  snapshotReplayCheckout,
  WORKTREES_DIR,
  type ReplayCheckout,
} from "../git/index.js";
import { guardGateRun } from "./dispatch-guard.js";
import type { EventDraft } from "./event-log.js";
import { appendPrivateFile, ensurePrivateDir, readPrivateFile, writePrivateFile } from "./guard.js";
import { gatesAt } from "./jobs.js";
import type {
  Kernel,
  LookbackReplay,
  LookbackReplayTrial,
  PinnedPrompt,
  ReplayTrialOutcome,
  RunHandle,
} from "./kernel.js";
import { pinBlocker } from "./prompt-target.js";
import { roleWorktreeId } from "./role-worktree.js";
import type { RoleRunRecord } from "./state.js";

/** The replays RETRO planned for a run, as kept in the private directory. */
export interface ReplayPlan {
  readonly v: 1;
  readonly replays: readonly LookbackReplay[];
}

/** A trial's place in the plan. */
export interface TrialRef {
  /** Index of the replay in the plan. */
  readonly replay: number;
  /** Index of the trial in its replay. */
  readonly n: number;
}

/** What the dispatcher needs to hand a trial out (`StepSpec.replay`). */
export interface ReplayStepRef extends TrialRef {
  readonly prompt: PinnedPrompt;
  readonly pack: TaskPack;
  readonly base: string;
}

/** The trial step RETRO wants now (a `StepSpec` the dispatcher hands out). */
export interface ReplayStep {
  readonly key: string;
  readonly role: string;
  readonly mode?: string;
  readonly subject?: NonNullable<TaskPack["subject"]>;
  readonly note: string;
  readonly purpose: "lookback_replay";
  readonly replay: ReplayStepRef;
}

type TrialRow =
  | {
      readonly kind: "dispatched";
      readonly replay: number;
      readonly n: number;
      readonly action: string;
    }
  | {
      readonly kind: "graded";
      readonly replay: number;
      readonly n: number;
      readonly passed: boolean;
      readonly tokens: number;
    }
  | { readonly kind: "finished"; readonly replay: number };

const replaysDir = (k: Kernel): string => join(k.guardDir, "replays");
const planFile = (k: Kernel, run: string): string => join(replaysDir(k), `${run}.json`);
const rowsFile = (k: Kernel, run: string): string => join(replaysDir(k), `${run}.jsonl`);

/** The run's replay plan, or `null` before RETRO planned it. */
export const readReplayPlan = (k: Kernel, run: string): ReplayPlan | null => {
  const text = readPrivateFile(planFile(k, run));
  if (text === null) return null;
  try {
    const plan = JSON.parse(text) as Partial<ReplayPlan> | null;
    return plan?.v === 1 && Array.isArray(plan.replays) ? (plan as ReplayPlan) : null;
  } catch {
    return null;
  }
};

const writePlan = (k: Kernel, run: string, plan: ReplayPlan): void => {
  ensurePrivateDir(replaysDir(k));
  writePrivateFile(planFile(k, run), `${JSON.stringify(plan)}\n`);
};

const readRows = (k: Kernel, run: string): TrialRow[] => {
  const text = readPrivateFile(rowsFile(k, run)) ?? "";
  return text.split("\n").flatMap((line): TrialRow[] => {
    if (line.trim() === "") return [];
    try {
      return [JSON.parse(line) as TrialRow];
    } catch {
      return [];
    }
  });
};

const appendRow = (k: Kernel, run: string, row: TrialRow): void => {
  ensurePrivateDir(replaysDir(k));
  appendPrivateFile(rowsFile(k, run), `${JSON.stringify(row)}\n`);
};

const key = (t: TrialRef): string => `${String(t.replay)}-${String(t.n)}`;

interface ReplayProgress {
  readonly plan: ReplayPlan;
  /** Trial → the action that ran it. */
  readonly dispatched: ReadonlyMap<string, string>;
  readonly graded: ReadonlyMap<string, ReplayTrialOutcome>;
  readonly finished: ReadonlySet<number>;
}

const progressOf = (k: Kernel, run: string): ReplayProgress | null => {
  const plan = readReplayPlan(k, run);
  if (plan === null) return null;
  const dispatched = new Map<string, string>();
  const graded = new Map<string, ReplayTrialOutcome>();
  const finished = new Set<number>();
  for (const row of readRows(k, run)) {
    if (row.kind === "dispatched") dispatched.set(key(row), row.action);
    else if (row.kind === "graded")
      graded.set(key(row), { n: row.n, passed: row.passed, tokens: row.tokens });
    else finished.add(row.replay);
  }
  return { plan, dispatched, graded, finished };
};

/**
 * The actions that ran a run's replay trials (reading 176). Lookback reads the run without them:
 * a trial is a measurement of a version, not a dispatch of the run's work, so it is no trace, no
 * attribution and no scorecard dispatch.
 */
export const replayTrialActions = (k: Kernel, run: string): ReadonlySet<string> =>
  new Set(progressOf(k, run)?.dispatched.values() ?? []);

/** The trial a role run is, when it is one. */
export const replayTrialOf = (
  k: Kernel,
  h: RunHandle,
  action: string,
): (TrialRef & { readonly trial: LookbackReplayTrial }) | undefined => {
  const progress = progressOf(k, h.state.id);
  if (progress === null) return undefined;
  for (const [id, a] of progress.dispatched) {
    if (a !== action) continue;
    const [replay, n] = id.split("-").map(Number) as [number, number];
    const trial = progress.plan.replays[replay]?.trials[n];
    return trial === undefined ? undefined : { replay, n, trial };
  }
  return undefined;
};

/** Where a trial runs: a task-less role's worktree path, its git directory kept private. */
export const trialCheckout = (
  k: Kernel,
  run: string,
  action: string,
  base: string,
): ReplayCheckout => ({
  path: `${WORKTREES_DIR}/${roleWorktreeId(run, action)}`,
  gitDir: join(replaysDir(k), `${run}--${action}.git`),
  base,
});

/** The host a run's replays run on: its Lead's (reading 176). */
const leadHostOf = (k: Kernel, h: RunHandle): HostId =>
  k.liveLeadHost(h.state.id) ?? h.state.limit?.host ?? k.hostFor({ host: null });

/** Why a replay cannot run in this RETRO (it then waits for the next one), or `null`. */
const replayBlocker = (k: Kernel, h: RunHandle, replay: LookbackReplay): string | null => {
  const lead = leadHostOf(k, h);
  if (replay.host !== lead)
    return `its trials run on ${replay.host}, and this run's Lead runs on ${lead}`;
  const capabilities = k.deps.adapters[replay.host]?.capabilities ?? {
    subagents: false,
    headless: false,
  };
  const plan = planDispatch(
    "lookback_replay",
    k.config().hosts.dispatch,
    capabilities,
    k.liveLeadHost(h.state.id),
  );
  if (plan !== "subagent" && plan !== "headless")
    return `${replay.host} can run no lookback_replay trial now (hosts.dispatch ${k.config().hosts.dispatch})`;
  // AD-21 rule 6: only a target that can take a pin is replayed (its trials must run their arm)
  const agent = agentNameFor(replay.role, replay.mode);
  const blocker = pinBlocker(k.deps.plugins.promptParts?.(agent, replay.host), replay.host, plan);
  if (blocker !== null) return `${agent} cannot run a candidate: ${blocker}`;
  return replay.trials.length === 0 ? "it has no trial to run" : null;
};

/**
 * Plans the run's replays (a job's work; the plan is written whatever happens, so RETRO never
 * plans twice): the wired Lookback's replays the run can start, each one's trials in order. One
 * that cannot start is left out with a notice (it stays pending for the next RETRO).
 */
export const planReplays = async (k: Kernel, h: RunHandle): Promise<ReplayPlan> => {
  const lookback = k.lookbackRetro();
  let replays: readonly LookbackReplay[] = [];
  if (lookback?.replays !== undefined && lookback.finishReplay !== undefined) {
    try {
      const planned = await lookback.replays(h.state);
      if (planned.wait !== undefined)
        k.notice(`lookback replays of run ${h.state.id} wait for the next RETRO: ${planned.wait}`);
      replays = planned.replays.filter((replay) => {
        const why = replayBlocker(k, h, replay);
        if (why !== null)
          k.notice(`the replay of proposal ${replay.proposal} waits for the next RETRO: ${why}`);
        return why === null;
      });
    } catch (error) {
      k.notice(
        `lookback replays of run ${h.state.id} could not be planned: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const plan: ReplayPlan = { v: 1, replays };
  writePlan(k, h.state.id, plan);
  return plan;
};

const ended = (run: RoleRunRecord | undefined): boolean =>
  run !== undefined && ["rejected", "failed", "interrupted"].includes(run.status);

const tokensOf = (run: RoleRunRecord | undefined): number =>
  run?.tokens === null || run?.tokens === undefined ? 0 : run.tokens.in + run.tokens.out;

/** Records a trial that did not pass without a grade, and drops its checkout. */
const failTrial = (k: Kernel, h: RunHandle, t: TrialRef, action: string | undefined): void => {
  const run = action === undefined ? undefined : h.state.roleRuns.get(action);
  appendRow(k, h.state.id, {
    kind: "graded",
    replay: t.replay,
    n: t.n,
    passed: false,
    tokens: tokensOf(run),
  });
  if (action !== undefined) {
    const trial = readReplayPlan(k, h.state.id)?.replays[t.replay]?.trials[t.n];
    if (trial !== undefined)
      removeReplayCheckout(k.deps.repoRoot, trialCheckout(k, h.state.id, action, trial.base));
  }
};

/**
 * A trial the dispatcher refused to hand out (the Lead session's sandbox, the platform): it did not
 * pass, with a notice, so RETRO moves on instead of asking the human (a replay changes nothing).
 */
export const refuseTrial = (k: Kernel, h: RunHandle, ref: TrialRef, reason: string): void => {
  k.notice(`replay trial ${key(ref)} of run ${h.state.id} was not run: ${reason}`);
  failTrial(k, h, ref, undefined);
};

/**
 * Creates a trial's clean checkout and records its dispatch (callers then hand the step out with
 * the checkout as its working directory). Returns the checkout's absolute path, or `null` when it
 * could not be made: the trial then did not pass, with a notice.
 */
export const prepareTrial = async (
  k: Kernel,
  h: RunHandle,
  ref: ReplayStepRef,
  action: string,
): Promise<string | null> => {
  const checkout = trialCheckout(k, h.state.id, action, ref.base);
  try {
    await createReplayCheckout(k.deps.repoRoot, checkout);
  } catch (error) {
    k.notice(
      `replay trial ${key(ref)} of run ${h.state.id} has no checkout at ${ref.base.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    failTrial(k, h, ref, undefined);
    return null;
  }
  appendRow(k, h.state.id, { kind: "dispatched", replay: ref.replay, n: ref.n, action });
  return join(k.deps.repoRoot, checkout.path);
};

/** A trial's result was accepted: commits its work in the checkout and returns the head. */
export const snapshotTrial = (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  trial: LookbackReplayTrial,
): Promise<string> =>
  snapshotReplayCheckout(
    k.deps.repoRoot,
    trialCheckout(k, h.state.id, run.action_id, trial.base),
    `vtc: replay trial ${run.action_id}`,
  );

/**
 * Grades an accepted trial through the Gate Runner (a job): its checkout's `base..head` against
 * the gates committed at its base and the recorded pack's scope; a gate run that cannot run did
 * not pass. The checkout is removed after.
 */
export const startTrialGrade = (
  k: Kernel,
  h: RunHandle,
  t: TrialRef & { readonly trial: LookbackReplayTrial },
  action: string,
  head: string,
): void => {
  const lookback = k.lookbackRetro();
  k.spawn(h, `replay-grade:${h.state.id}:${key(t)}`, async () => {
    const checkout = trialCheckout(k, h.state.id, action, t.trial.base);
    let passed = false;
    try {
      const gates = await gatesAt(k, t.trial.base);
      if (gates === null) throw new Error(`no committed gates.yml at ${t.trial.base.slice(0, 12)}`);
      if (lookback?.gradeTrial === undefined) throw new Error("no Lookback grader is wired");
      const grade = lookback.gradeTrial.bind(lookback);
      const request: GateRunRequest = GateRunRequestSchema.parse({
        run: h.state.id,
        reason: "round",
        scope: "affected",
        base: t.trial.base,
        head,
        checkout: checkout.path,
        files_scope: t.trial.pack.files_scope,
        req_tags: t.trial.pack.requirements.map((r) => r.id),
        gates_config_hash: gates.sha256,
      });
      passed = await guardGateRun(k, h, `replay trial ${action}`, () => grade(request));
    } catch (error) {
      k.notice(
        `replay trial ${action} of run ${h.state.id} could not be graded: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    await k.serial(h, () => {
      if (progressOf(k, h.state.id)?.graded.has(key(t)) !== true)
        appendRow(k, h.state.id, {
          kind: "graded",
          replay: t.replay,
          n: t.n,
          passed,
          tokens: tokensOf(h.state.roleRuns.get(action)),
        });
      removeReplayCheckout(k.deps.repoRoot, checkout);
      return Promise.resolve();
    });
  });
};

/** The next trial step, when no trial runs or waits for its grade. */
export const replaySteps = (k: Kernel, h: RunHandle): ReplayStep[] => {
  const progress = progressOf(k, h.state.id);
  if (progress === null) return [];
  for (const [id, action] of progress.dispatched) {
    if (progress.graded.has(id)) continue;
    // one trial at a time: it is in flight, or its grade is not in yet
    if (h.state.roleRuns.get(action) !== undefined) return [];
  }
  for (const [replay, r] of progress.plan.replays.entries()) {
    for (const [n, trial] of r.trials.entries()) {
      const id = key({ replay, n });
      if (progress.dispatched.has(id) || progress.graded.has(id)) continue;
      return [
        {
          key: `retro:replay:${id}`,
          role: trial.role,
          ...(trial.mode === undefined ? {} : { mode: trial.mode }),
          ...(trial.pack.subject === undefined ? {} : { subject: trial.pack.subject }),
          note: `Lookback replay (§13 step 3) of proposal ${r.proposal}: work exactly as the task pack says; this run is graded by the gates and changes nothing outside its checkout.`,
          purpose: "lookback_replay",
          replay: { replay, n, prompt: trial.prompt, pack: trial.pack, base: trial.base },
        },
      ];
    }
  }
  return [];
};

/**
 * RETRO's replay stage (callers hold the run's lock): plans the replays once, records the trials
 * that ended without a result, re-grades an accepted trial whose grade a restart lost, and writes
 * each replay's result once its trials are graded. `done` once nothing is left to run.
 */
export const stepReplays = (k: Kernel, h: RunHandle): "done" | "busy" => {
  const run = h.state.id;
  const progress = progressOf(k, run);
  if (progress === null) {
    if (!k.isRunning(`replay-plan:${run}`))
      k.spawn(h, `replay-plan:${run}`, async () => {
        await planReplays(k, h);
      });
    return "busy";
  }
  let busy = false;
  for (const [id, action] of progress.dispatched) {
    if (progress.graded.has(id)) continue;
    const [replay, n] = id.split("-").map(Number) as [number, number];
    const record = h.state.roleRuns.get(action);
    // ended without a result, or never handed out (a restart between the two)
    if (record === undefined || ended(record)) {
      failTrial(k, h, { replay, n }, action);
      continue;
    }
    busy = true;
    const trial = progress.plan.replays[replay]?.trials[n];
    if (
      record.status === "submitted" &&
      record.head !== undefined &&
      trial !== undefined &&
      !k.isRunning(`replay-grade:${run}:${id}`)
    )
      startTrialGrade(k, h, { replay, n, trial }, action, record.head);
  }
  if (busy) return "busy";
  const lookback = k.lookbackRetro();
  for (const [index, replay] of progress.plan.replays.entries()) {
    if (progress.finished.has(index)) continue;
    const outcomes = replay.trials.flatMap((_t, n) => {
      const o = progress.graded.get(key({ replay: index, n }));
      return o === undefined ? [] : [o];
    });
    if (outcomes.length < replay.trials.length) return "busy";
    const job = `replay-finish:${run}:${String(index)}`;
    if (!k.isRunning(job))
      k.spawn(h, job, async () => {
        let events: readonly EventDraft[] = [];
        try {
          if (lookback?.finishReplay === undefined) throw new Error("no Lookback is wired");
          events = await lookback.finishReplay(replay, outcomes, h.state);
        } catch (error) {
          k.notice(
            `the replay of proposal ${replay.proposal} could not be written: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await k.serial(h, () => {
          if (progressOf(k, run)?.finished.has(index) === true) return Promise.resolve();
          for (const event of events) k.emit(h, event);
          appendRow(k, run, { kind: "finished", replay: index });
          return Promise.resolve();
        });
      });
    return "busy";
  }
  return "done";
};
