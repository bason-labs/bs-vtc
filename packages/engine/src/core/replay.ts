/**
 * Lookback replays at RETRO (spec §13 step 3; AD-21 rule 6; spine §5 reading 176). Once every
 * lookback target of the run is settled, RETRO asks the wired Lookback for the replays it may run
 * now (`LookbackRetro.replays`: one per proposal recorded and not yet replayed, under the same
 * weekly-window and budget checks as the lookback role) and runs their `lookback_replay` trials
 * one at a time, like any task-less role (`planDispatch`, in-session or headless):
 * - each trial is a recorded dispatch run again with one arm's prompt version, in a clean checkout
 *   at the commit that dispatch started from, with no refs past it (`createReplayCheckout`), in a
 *   fresh private directory outside the user's repo (`newReplayTree`, recorded with the
 *   dispatch), so no relative path reaches the user's current files or their `.git`; the
 *   headless sandbox applies there as for any role, and the Gate Runner's write-scope check (L5)
 *   grades its writes. The pack is the recorded one, without its task (a trial changes no task),
 *   with the arm's editable section first. A trial whose arm the dispatcher would not run as
 *   planned (no pin can apply now) is not run at all, so no arm is ever measured with another's
 *   prompt. The host sandboxes deny no reads, so a trial that knows the repo's absolute path (an
 *   in-session trial runs in the Lead's session) can still read it (`replay-checkout.ts`);
 * - its result is checked against the role's contract and its work committed in the checkout;
 *   once the head is readable in the user's repo (`exposeReplayHead`) it is graded through the
 *   Gate Runner (`LookbackRetro.gradeTrial`) in a clean verification checkout of that head, like
 *   every gate run, so nothing the trial left ignored in its tree feeds a gate; a rejected,
 *   failed or interrupted trial did not pass, and a checkout whose git directory changed is an
 *   incident (`checkout_write`). Nothing a trial does reaches a task, the user's checkout or the
 *   integration branch;
 * - once every trial of a replay is graded, Lookback writes its result
 *   (`LookbackRetro.finishReplay`: `ReplayResult`, `lookback.replay_finished` with the SHA-256).
 * A replay waits for the next RETRO (it stays pending, and the next RETRO plans it again) when its
 * host is not the run's Lead host, no dispatch can run it now, or its role changes no file (a
 * verdict role: the gates would grade the same base for both arms, so nothing could tell them
 * apart). The weekly-window and budget checks run again before every trial
 * (`LookbackRetro.replayWait`, the run's budget), and a headless trial whose preflight fails stops
 * the replays the same way, without pausing the delivered run: the run finishes, and the replays
 * not yet written wait for the next RETRO. The plan, the trial dispatches and their grades live in
 * the engine's private directory (`<guard>/replays/`), where no role can write, so a restart picks
 * the replays up where they stopped.
 */
import { join } from "node:path";
import {
  agentNameFor,
  GateRunRequestSchema,
  planDispatch,
  resolveRoleMode,
  type GateRunRequestInput,
  type HostId,
  type TaskPack,
} from "@vtc/shared";
import {
  createReplayCheckout,
  exposeReplayHead,
  newReplayTree,
  removeReplayCheckout,
  ReplayCheckoutTamperedError,
  snapshotReplayCheckout,
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
      /** The trial's work tree (absolute, outside the user's repo, `newReplayTree`). */
      readonly tree: string;
    }
  | {
      readonly kind: "graded";
      readonly replay: number;
      readonly n: number;
      readonly passed: boolean;
      readonly tokens: number;
    }
  | { readonly kind: "finished"; readonly replay: number }
  /** The replays stopped: the ones not yet finished wait for the next RETRO. */
  | { readonly kind: "deferred"; readonly reason: string };

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
  /** Action → its trial's work tree. */
  readonly trees: ReadonlyMap<string, string>;
  readonly graded: ReadonlyMap<string, ReplayTrialOutcome>;
  readonly finished: ReadonlySet<number>;
  /** Why the replays stopped, once they did. */
  readonly deferred?: string;
}

const progressOf = (k: Kernel, run: string): ReplayProgress | null => {
  const plan = readReplayPlan(k, run);
  if (plan === null) return null;
  const dispatched = new Map<string, string>();
  const trees = new Map<string, string>();
  const graded = new Map<string, ReplayTrialOutcome>();
  const finished = new Set<number>();
  let deferred: string | undefined;
  for (const row of readRows(k, run)) {
    if (row.kind === "dispatched") {
      dispatched.set(key(row), row.action);
      if (typeof row.tree === "string" && row.tree !== "") trees.set(row.action, row.tree);
    } else if (row.kind === "graded")
      graded.set(key(row), { n: row.n, passed: row.passed, tokens: row.tokens });
    else if (row.kind === "finished") finished.add(row.replay);
    else deferred ??= row.reason;
  }
  return {
    plan,
    dispatched,
    trees,
    graded,
    finished,
    ...(deferred === undefined ? {} : { deferred }),
  };
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

/** A trial's checkout: its work tree outside the user's repo, its git directory kept private. */
const checkoutAt = (
  k: Kernel,
  run: string,
  action: string,
  base: string,
  tree: string,
): ReplayCheckout => ({ tree, gitDir: join(replaysDir(k), `${run}--${action}.git`), base });

/** Where a recorded trial runs, or `undefined` when its dispatch row names no work tree. */
export const trialCheckout = (
  k: Kernel,
  run: string,
  action: string,
  base: string,
): ReplayCheckout | undefined => {
  const tree = progressOf(k, run)?.trees.get(action);
  return tree === undefined ? undefined : checkoutAt(k, run, action, base, tree);
};

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
  if (!changesFiles(k, replay))
    return `${agent} changes no file, so the gates would grade the same base for both arms; a replay of a verdict role needs a grader that scores its verdicts against the recorded outcome`;
  return replay.trials.length === 0 ? "it has no trial to run" : null;
};

/**
 * Whether the replayed role can leave work in its checkout for the gates to grade: a role that may
 * write files and whose contract names an artifact. A verdict role's trial leaves its head at the
 * base, so the Gate Runner grades the same commit for every arm.
 */
const changesFiles = (k: Kernel, replay: Pick<LookbackReplay, "role" | "mode">): boolean => {
  const contract = k.deps.roles.get(replay.role);
  if (contract === undefined) return false;
  const effective = resolveRoleMode(contract, replay.mode);
  const role = effective.ok ? effective.contract : contract;
  return role.tools.profile !== "read_only" && role.output.artifacts.length > 0;
};

/**
 * Why the replays must stop now (AD-21 rule 8, reading 176), or `null`: the run's budget is spent,
 * or the wired Lookback's weekly-window and budget checks say so. Checked before every trial.
 */
const replayWait = (k: Kernel, h: RunHandle): string | null => {
  const budget = h.state.runBudget;
  if (budget !== null && budget.spent_usd >= budget.budget_usd)
    return `the run spent $${budget.spent_usd.toFixed(2)} of its $${budget.budget_usd.toFixed(2)} budget`;
  try {
    return k.lookbackRetro()?.replayWait?.(h.state) ?? null;
  } catch (error) {
    return `the weekly window and budget could not be checked: ${error instanceof Error ? error.message : String(error)}`;
  }
};

/**
 * Stops the run's replays (callers hold the run's lock): the ones not yet written wait for the
 * next RETRO, which plans them again, and the run finishes once no trial is in flight. Nothing
 * pauses the delivered run.
 */
export const deferReplays = (k: Kernel, h: RunHandle, reason: string): void => {
  const progress = progressOf(k, h.state.id);
  if (progress === null || progress.deferred !== undefined) return;
  appendRow(k, h.state.id, { kind: "deferred", reason: reason.slice(0, 500) });
  k.notice(`the lookback replays of run ${h.state.id} stop and wait for the next RETRO: ${reason}`);
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
    const checkout =
      trial === undefined ? undefined : trialCheckout(k, h.state.id, action, trial.base);
    if (checkout !== undefined) removeReplayCheckout(checkout);
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
 * Records a trial's dispatch with a fresh work tree outside the user's repo, then creates its
 * clean checkout there (callers then hand the step out with the checkout as its working
 * directory). The row comes first, so a crash in between leaves a dispatch with no role run,
 * whose checkout `stepReplays` removes. Returns the checkout's absolute path, or `null` when it
 * could not be made: the trial then did not pass, with a notice.
 */
export const prepareTrial = async (
  k: Kernel,
  h: RunHandle,
  ref: ReplayStepRef,
  action: string,
): Promise<string | null> => {
  let tree: string;
  try {
    tree = newReplayTree();
  } catch (error) {
    k.notice(
      `replay trial ${key(ref)} of run ${h.state.id} has no directory for its checkout: ${error instanceof Error ? error.message : String(error)}`,
    );
    failTrial(k, h, ref, undefined);
    return null;
  }
  const checkout = checkoutAt(k, h.state.id, action, ref.base, tree);
  appendRow(k, h.state.id, { kind: "dispatched", replay: ref.replay, n: ref.n, action, tree });
  try {
    await createReplayCheckout(k.deps.repoRoot, checkout);
  } catch (error) {
    k.notice(
      `replay trial ${key(ref)} of run ${h.state.id} has no checkout at ${ref.base.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    failTrial(k, h, ref, action);
    return null;
  }
  return tree;
};

/**
 * A trial's checkout whose git directory changed after the engine made it (a role wrote in the
 * engine's private directory): an incident; the engine ran no git there, and the trial did not
 * pass.
 */
const recordTrialTamper = (
  k: Kernel,
  h: RunHandle,
  action: string,
  error: ReplayCheckoutTamperedError,
): void => {
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    data: {
      kind: "checkout_write",
      detail:
        `replay trial ${action} changed the git directory of its checkout (${error.paths.join(", ") || "its fingerprint is gone"}); the engine ran no git there and the trial did not pass`.slice(
          0,
          2000,
        ),
    },
  });
};

/**
 * A trial's result was accepted (callers hold the run's lock): commits its work in the checkout
 * and returns the head. A checkout whose git directory changed is an incident, and throws.
 */
export const snapshotTrial = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
  trial: LookbackReplayTrial,
): Promise<string> => {
  const checkout = trialCheckout(k, h.state.id, run.action_id, trial.base);
  if (checkout === undefined) throw new Error(`replay trial ${run.action_id} has no checkout`);
  try {
    return await snapshotReplayCheckout(checkout, `vtc: replay trial ${run.action_id}`);
  } catch (error) {
    if (error instanceof ReplayCheckoutTamperedError) recordTrialTamper(k, h, run.action_id, error);
    throw error;
  }
};

/**
 * Grades an accepted trial through the Gate Runner (a job): its `base..head` against the gates
 * committed at its base and the recorded pack's scope, once the head's objects are in the user's
 * repo (the Gate Runner's git reads that repo), in a clean verification checkout of the head made
 * for the grade and removed after it, like every gate run (`runGates`): never in the trial's own
 * tree, where what the role left ignored (dependencies, build output, `.env`) would feed the
 * gates. A gate run that cannot run did not pass. The trial's checkout is removed after.
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
      if (checkout === undefined) throw new Error("its dispatch names no checkout");
      const gates = await gatesAt(k, t.trial.base);
      if (gates === null) throw new Error(`no committed gates.yml at ${t.trial.base.slice(0, 12)}`);
      if (lookback?.gradeTrial === undefined) throw new Error("no Lookback grader is wired");
      const grade = lookback.gradeTrial.bind(lookback);
      await exposeReplayHead(k.deps.repoRoot, checkout, head);
      const request: Omit<GateRunRequestInput, "checkout"> = {
        run: h.state.id,
        reason: "round",
        scope: "affected",
        base: t.trial.base,
        head,
        files_scope: t.trial.pack.files_scope,
        req_tags: t.trial.pack.requirements.map((r) => r.id),
        gates_config_hash: gates.sha256,
      };
      passed = await guardGateRun(k, h, `replay trial ${action}`, async () => {
        const clean = await k.deps.git.createCleanCheckout(head);
        try {
          return await grade(GateRunRequestSchema.parse({ ...request, checkout: clean }));
        } finally {
          await k.deps.git.removeCheckout(clean);
        }
      });
    } catch (error) {
      if (error instanceof ReplayCheckoutTamperedError) {
        const tampered = error;
        await k.serial(h, () => {
          recordTrialTamper(k, h, action, tampered);
          return Promise.resolve();
        });
      }
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
      if (checkout !== undefined) removeReplayCheckout(checkout);
      return Promise.resolve();
    });
  });
};

/**
 * The next trial step, when no trial runs or waits for its grade, and the weekly window and budget
 * still allow one (else `stepReplays` stops the replays).
 */
export const replaySteps = (k: Kernel, h: RunHandle): ReplayStep[] => {
  const progress = progressOf(k, h.state.id);
  if (progress === null || progress.deferred !== undefined) return [];
  for (const [id, action] of progress.dispatched) {
    if (progress.graded.has(id)) continue;
    // one trial at a time: it is in flight, or its grade is not in yet
    if (h.state.roleRuns.get(action) !== undefined) return [];
  }
  if (replayWait(k, h) !== null) return [];
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
 * that ended without a result, re-grades an accepted trial whose grade a restart lost, writes each
 * replay's result once its trials are graded, and stops the replays when the weekly window or the
 * budget no longer allows a trial ({@link deferReplays}). `done` once nothing is left to run.
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
    if (outcomes.length < replay.trials.length) {
      // stopped: the replays not yet graded wait for the next RETRO
      if (progress.deferred !== undefined) continue;
      const wait = replayWait(k, h);
      if (wait === null) return "busy";
      deferReplays(k, h, wait);
      return "done";
    }
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
