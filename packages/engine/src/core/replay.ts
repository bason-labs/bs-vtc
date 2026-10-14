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
 *   headless sandbox applies there as for any role (the recorded task's protected tests kept out
 *   of its writes), and the Gate Runner's write-scope check (L5) grades its writes. The pack is
 *   the recorded one, without its task (a trial changes no task), with the arm's editable section
 *   first. A trial whose arm the dispatcher would not run as planned (no pin can apply now) is not
 *   run at all, so no arm is ever measured with another's prompt. The host sandboxes deny no
 *   reads, so a trial that knows the repo's absolute path (an in-session trial runs in the Lead's
 *   session) can still read it (`replay-checkout.ts`);
 * - its result is checked against the role's contract and its work committed in the checkout;
 *   once the head is readable in the user's repo (`exposeReplayHead`) it is graded through the
 *   Gate Runner (`LookbackRetro.gradeTrial`) in a clean verification checkout of that head, like
 *   every gate run, and as the recorded round was: the recorded task's QA-owned tests and the
 *   protected configs at the base by checksum, its hidden acceptance tests copied in. A trial whose
 *   role was rejected or failed did not pass, and a checkout whose git directory changed is an
 *   incident (`checkout_write`) and did not pass. Nothing a trial does reaches a task, the user's
 *   checkout or the integration branch;
 * - a trial that measured nothing (its arm or the dispatcher refused it, its checkout could not be
 *   made, its role run was interrupted or stopped, or its grade could not run or reported
 *   `infra_error`) is not counted as a failure: its replay is set aside for this RETRO and waits
 *   for the next one, where it is planned again from the start;
 * - once every trial of a replay is graded, Lookback writes its result
 *   (`LookbackRetro.finishReplay`: `ReplayResult`, `lookback.replay_finished` with the SHA-256).
 * A replay waits for the next RETRO (it stays pending, and the next RETRO plans it again) when its
 * host is not the run's Lead host, no dispatch can run it now, or its role changes no file (a
 * verdict role: the gates would grade the same base for both arms, so nothing could tell them
 * apart; the same reason is told once per proposal). That last rule is an OPEN SPINE DEVIATION,
 * not a settled design: reading 166 names `spec_verifier` the first role a pin and a replay can
 * reach on both hosts (reading 176), and with this rule no verdict role is ever replayed, so
 * `vtc lookback approve` never starts a canary for one. It is escalated to the Lead (a verdict
 * grader that scores a trial's verdict against the recorded outcome, or an amendment of readings
 * 166 and 176 and the §7 Lookback-replays row); until it is decided the engine refuses rather
 * than grade two identical bases. The weekly-window and budget checks run
 * again before every trial (`LookbackRetro.replayWait`, the run's budget), and a headless trial
 * whose preflight fails stops the replays the same way, without pausing the delivered run: the
 * run finishes, and the replays not yet written wait for the next RETRO. The plan, the trial
 * dispatches and their grades live in the engine's private directory (`<guard>/replays/`), where
 * no role can write, so a restart picks the replays up where they stopped. That file is the only
 * cache of which role runs are trials: since contracts 4.11.0 (spine §5 reading 177) a trial's
 * `role.dispatched` carries `purpose: lookback_replay` and its `replay` reference, so a clone or
 * a machine without this file still tells trial dispatches from the run's own work (AD-7 rules 1,
 * 5 and 10); `lookbackEvents` filters on the logged marker and on this file, for logs written
 * before 4.11.0.
 *
 * Action ids are the run's role-run count plus one, so a trial that never got its role run (its
 * checkout could not be made, or the engine stopped before the dispatch) leaves its id to the next
 * trial: an action belongs to the trial whose `dispatched` row for it is the latest, and each
 * trial's git directory is keyed by the trial as well as the action.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import {
  agentNameFor,
  GateRunRequestSchema,
  GitShaSchema,
  HostIdSchema,
  PromptVersionRefSchema,
  RoleIdSchema,
  SlugSchema,
  planDispatch,
  resolveRoleMode,
  TaskIdSchema,
  type GateRunRequestInput,
  type HostId,
  type ReplayTrialRef,
  type TaskPack,
} from "@vtc/shared";
import {
  createReplayCheckout,
  exposeReplayHead,
  isReplayTree,
  newReplayTree,
  removeReplayCheckout,
  ReplayCheckoutTamperedError,
  snapshotReplayCheckout,
  type ReplayCheckout,
} from "../git/index.js";
import { guardGateRun } from "./dispatch-guard.js";
import type { EventDraft } from "./event-log.js";
import { appendPrivateFile, ensurePrivateDir, readPrivateFile, writePrivateFile } from "./guard.js";
import { gatesAt, protectedConfigsAt } from "./jobs.js";
import type {
  Kernel,
  LookbackReplay,
  LookbackReplayTrial,
  PinnedPrompt,
  ReplayTrialOutcome,
  RunHandle,
} from "./kernel.js";
import { pinBlocker } from "./prompt-target.js";
import { countsAsFailure } from "./queries.js";
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
  /** The recorded task's protected tests (`LookbackReplayTrial.protectedPaths`). */
  readonly protectedPaths?: readonly string[];
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

export type TrialRow =
  /** The trial's checkout is being made (a crash before `dispatched` leaves it to remove). */
  | {
      readonly kind: "preparing";
      readonly replay: number;
      readonly n: number;
      readonly action: string;
      readonly tree: string;
    }
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
  /** The trial measured nothing (an infrastructure outcome): its replay waits for the next RETRO. */
  | {
      readonly kind: "unmeasured";
      readonly replay: number;
      readonly n: number;
      readonly reason: string;
    }
  | { readonly kind: "finished"; readonly replay: number }
  /** The replays stopped: the ones not yet finished wait for the next RETRO. */
  | { readonly kind: "deferred"; readonly reason: string };

const replaysDir = (k: Kernel): string => join(k.guardDir, "replays");
const planFile = (k: Kernel, run: string): string => join(replaysDir(k), `${run}.json`);
const rowsFile = (k: Kernel, run: string): string => join(replaysDir(k), `${run}.jsonl`);
/** Proposal → the reason its replay was last left out with (told once per reason). */
const leftOutFile = (k: Kernel): string => join(replaysDir(k), "left-out.json");

/** Plans as written or first read, per engine and run: a plan never changes once written. */
const plans = new WeakMap<Kernel, Map<string, ReplayPlan>>();
const planCache = (k: Kernel): Map<string, ReplayPlan> => {
  let cache = plans.get(k);
  if (cache === undefined) {
    cache = new Map();
    plans.set(k, cache);
  }
  return cache;
};

/**
 * The plan and trial rows are read back as trusted after a restart (spine §5 reading 182): their
 * directory is role-unwritable (`ROLE_DENIED_VTC.homeWriteDeny` `guard/**`, contracts 4.12.0),
 * and each is checked against its shape on read as well, so a damaged or forged plan reads as
 * none and a forged row is dropped, never half-read.
 */
const PinnedPromptShape = z.looseObject({
  version: PromptVersionRefSchema,
  text: z.string(),
});
const TrialShape = z.looseObject({
  arm: z.enum(["a", "b", "aa"]),
  trial: z.int().positive(),
  task: z.string().min(1),
  regressionSet: z.boolean(),
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  host: HostIdSchema,
  prompt: PinnedPromptShape,
  pack: z.record(z.string(), z.unknown()),
  base: GitShaSchema,
  protectedPaths: z.array(z.string()).optional(),
});
const ReplayPlanShape = z.strictObject({
  v: z.literal(1),
  replays: z.array(
    z.looseObject({
      proposal: z.string().min(1),
      role: RoleIdSchema,
      mode: SlugSchema.optional(),
      host: HostIdSchema,
      trials: z.array(TrialShape),
    }),
  ),
});

/** A plan file's text as a plan, or `null` when it is not one the engine wrote. */
export const parseReplayPlan = (text: string): ReplayPlan | null => {
  try {
    const parsed = ReplayPlanShape.safeParse(JSON.parse(text) as unknown);
    return parsed.success ? (parsed.data as unknown as ReplayPlan) : null;
  } catch {
    return null;
  }
};

const Index = z.int().nonnegative();
const TrialRowShape = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("preparing"),
    replay: Index,
    n: Index,
    action: z.string().min(1),
    tree: z.string(),
  }),
  z.strictObject({
    kind: z.literal("dispatched"),
    replay: Index,
    n: Index,
    action: z.string().min(1),
    tree: z.string(),
  }),
  z.strictObject({
    kind: z.literal("graded"),
    replay: Index,
    n: Index,
    passed: z.boolean(),
    tokens: z.number().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("unmeasured"),
    replay: Index,
    n: Index,
    reason: z.string(),
  }),
  z.strictObject({ kind: z.literal("finished"), replay: Index }),
  z.strictObject({ kind: z.literal("deferred"), reason: z.string() }),
]);

/**
 * A rows file's text as its trial rows, in order: a line that is not a row the engine writes is
 * dropped. A row's work tree is kept only when it is one {@link newReplayTree} made
 * (`isReplayTree`), since engine git calls take it as their work tree; otherwise it reads as
 * none (`""`), and the trial has no checkout to grade or remove.
 */
export const parseTrialRows = (text: string): TrialRow[] =>
  text.split("\n").flatMap((line): TrialRow[] => {
    if (line.trim() === "") return [];
    let raw: unknown;
    try {
      raw = JSON.parse(line) as unknown;
    } catch {
      return [];
    }
    const parsed = TrialRowShape.safeParse(raw);
    if (!parsed.success) return [];
    const row = parsed.data;
    if ((row.kind === "preparing" || row.kind === "dispatched") && !isReplayTree(row.tree))
      return [{ ...row, tree: "" }];
    return [row];
  });

/** The run's replay plan, or `null` before RETRO planned it. */
export const readReplayPlan = (k: Kernel, run: string): ReplayPlan | null => {
  const cached = planCache(k).get(run);
  if (cached !== undefined) return cached;
  const text = readPrivateFile(planFile(k, run));
  if (text === null) return null;
  const plan = parseReplayPlan(text);
  if (plan !== null) planCache(k).set(run, plan);
  return plan;
};

const writePlan = (k: Kernel, run: string, plan: ReplayPlan): void => {
  ensurePrivateDir(replaysDir(k));
  writePrivateFile(planFile(k, run), `${JSON.stringify(plan)}\n`);
  planCache(k).set(run, plan);
};

const readRows = (k: Kernel, run: string): TrialRow[] =>
  parseTrialRows(readPrivateFile(rowsFile(k, run)) ?? "");

const appendRow = (k: Kernel, run: string, row: TrialRow): void => {
  ensurePrivateDir(replaysDir(k));
  appendPrivateFile(rowsFile(k, run), `${JSON.stringify(row)}\n`);
};

const key = (t: TrialRef): string => `${String(t.replay)}-${String(t.n)}`;

const refOf = (id: string): TrialRef => {
  const [replay, n] = id.split("-").map(Number) as [number, number];
  return { replay, n };
};

interface ReplayProgress {
  readonly plan: ReplayPlan;
  /** Trial → the action that ran it. */
  readonly dispatched: ReadonlyMap<string, string>;
  /**
   * Action → the trial it belongs to: the latest `dispatched` row for it (an action id a trial
   * that never got its role run left behind goes to the next trial).
   */
  readonly owner: ReadonlyMap<string, string>;
  /** Trial → the action whose checkout was being made (no `dispatched` row yet). */
  readonly preparing: ReadonlyMap<string, string>;
  /** Trial → its work tree. */
  readonly trees: ReadonlyMap<string, string>;
  readonly graded: ReadonlyMap<string, ReplayTrialOutcome>;
  /** Trial → why it measured nothing. */
  readonly unmeasured: ReadonlyMap<string, string>;
  /** Replays set aside for this RETRO: one of their trials measured nothing. */
  readonly setAside: ReadonlySet<number>;
  readonly finished: ReadonlySet<number>;
  /** Why the replays stopped, once they did. */
  readonly deferred?: string;
}

const settled = (p: ReplayProgress, id: string): boolean =>
  p.graded.has(id) || p.unmeasured.has(id);

const progressOf = (k: Kernel, run: string): ReplayProgress | null => {
  const plan = readReplayPlan(k, run);
  if (plan === null) return null;
  const dispatched = new Map<string, string>();
  const owner = new Map<string, string>();
  const preparing = new Map<string, string>();
  const trees = new Map<string, string>();
  const graded = new Map<string, ReplayTrialOutcome>();
  const unmeasured = new Map<string, string>();
  const setAside = new Set<number>();
  const finished = new Set<number>();
  let deferred: string | undefined;
  for (const row of readRows(k, run)) {
    if (row.kind === "preparing" || row.kind === "dispatched") {
      const id = key(row);
      if (typeof row.tree === "string" && row.tree !== "") trees.set(id, row.tree);
      if (row.kind === "preparing") preparing.set(id, row.action);
      else {
        preparing.delete(id);
        dispatched.set(id, row.action);
        owner.set(row.action, id);
      }
    } else if (row.kind === "graded")
      graded.set(key(row), { n: row.n, passed: row.passed, tokens: row.tokens });
    else if (row.kind === "unmeasured") {
      unmeasured.set(key(row), row.reason);
      setAside.add(row.replay);
    } else if (row.kind === "finished") finished.add(row.replay);
    else deferred ??= row.reason;
  }
  return {
    plan,
    dispatched,
    owner,
    preparing,
    trees,
    graded,
    unmeasured,
    setAside,
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

/** The trial a role run is, when it is one: the trial its action belongs to. */
export const replayTrialOf = (
  k: Kernel,
  h: RunHandle,
  action: string,
): (TrialRef & { readonly trial: LookbackReplayTrial }) | undefined => {
  const progress = progressOf(k, h.state.id);
  const id = progress?.owner.get(action);
  if (progress === null || id === undefined) return undefined;
  const ref = refOf(id);
  const trial = progress.plan.replays[ref.replay]?.trials[ref.n];
  return trial === undefined ? undefined : { ...ref, trial };
};

/**
 * A trial's checkout: its work tree outside the user's repo, its git directory kept private and
 * named by the trial and the action (an action id can pass from a trial that never ran to the
 * next one).
 */
const checkoutAt = (
  k: Kernel,
  run: string,
  t: TrialRef,
  action: string,
  base: string,
  tree: string,
): ReplayCheckout => ({
  tree,
  gitDir: join(replaysDir(k), `${run}--${action}--${key(t)}.git`),
  base,
});

/** Where a recorded trial runs, or `undefined` when no row names its work tree. */
const trialCheckout = (
  k: Kernel,
  run: string,
  t: TrialRef,
  action: string,
  base: string,
): ReplayCheckout | undefined => {
  const tree = progressOf(k, run)?.trees.get(key(t));
  return tree === undefined ? undefined : checkoutAt(k, run, t, action, base, tree);
};

/** Removes a trial's checkout; a work tree that is not a replay tree is left, with a notice. */
const dropCheckout = (k: Kernel, run: string, checkout: ReplayCheckout | undefined): void => {
  if (checkout === undefined) return;
  if (!removeReplayCheckout(checkout))
    k.notice(
      `a replay trial of run ${run} names ${checkout.tree} as its work tree, which is not a directory the engine made for one: it was not removed`,
    );
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
    // OPEN SPINE DEVIATION (readings 166, 176): escalated to the Lead, see the header
    return `${agent} changes no file, so the gates would grade the same base for both arms; a replay of a verdict role needs a grader that scores its verdicts against the recorded outcome (an open spine question on readings 166 and 176, waiting for the Lead)`;
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
 * Tells why a replay is left out of this RETRO, once per proposal and reason: a reason that lasts
 * (a verdict role, an agent that carries its own section) is not told again at every RETRO.
 */
const tellLeftOut = (k: Kernel, proposal: string, why: string): void => {
  let told: Record<string, string> = {};
  try {
    const parsed = JSON.parse(readPrivateFile(leftOutFile(k)) ?? "{}") as unknown;
    if (parsed !== null && typeof parsed === "object") told = parsed as Record<string, string>;
  } catch {
    told = {};
  }
  if (told[proposal] === why) return;
  k.notice(`the replay of proposal ${proposal} waits for the next RETRO: ${why}`);
  ensurePrivateDir(replaysDir(k));
  writePrivateFile(leftOutFile(k), `${JSON.stringify({ ...told, [proposal]: why })}\n`);
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
        if (why !== null) tellLeftOut(k, replay.proposal, why);
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

/** A role run that ended without an accepted result. */
const ended = (run: RoleRunRecord | undefined): boolean =>
  run !== undefined && ["rejected", "failed", "interrupted"].includes(run.status);

const tokensOf = (run: RoleRunRecord | undefined): number =>
  run?.tokens === null || run?.tokens === undefined ? 0 : run.tokens.in + run.tokens.out;

/** The trial at `t` in the run's plan. */
const trialAt = (k: Kernel, run: string, t: TrialRef): LookbackReplayTrial | undefined =>
  readReplayPlan(k, run)?.replays[t.replay]?.trials[t.n];

/**
 * The trial a `lookback_replay` dispatch names in its `role.dispatched.replay` (contracts 4.11.0,
 * spine §5 reading 177), or `undefined` when the plan no longer has it.
 */
export const replayTrialRef = (k: Kernel, run: string, t: TrialRef): ReplayTrialRef | undefined => {
  const replay = readReplayPlan(k, run)?.replays[t.replay];
  const trial = replay?.trials[t.n];
  return replay === undefined || trial === undefined
    ? undefined
    : { proposal: replay.proposal, task: trial.task, arm: trial.arm, trial: trial.trial };
};

/** Drops the checkout of the trial at `t` that `action` ran (when one was recorded). */
const dropTrialCheckout = (k: Kernel, run: string, t: TrialRef, action: string): void => {
  const trial = trialAt(k, run, t);
  if (trial !== undefined) dropCheckout(k, run, trialCheckout(k, run, t, action, trial.base));
};

/** Records a trial whose role ran and was rejected or failed: it did not pass. */
const failTrial = (k: Kernel, h: RunHandle, t: TrialRef, action: string): void => {
  appendRow(k, h.state.id, {
    kind: "graded",
    replay: t.replay,
    n: t.n,
    passed: false,
    tokens: tokensOf(h.state.roleRuns.get(action)),
  });
  dropTrialCheckout(k, h.state.id, t, action);
};

/**
 * Records a trial that measured nothing (an infrastructure outcome, never the role's): it counts
 * neither way, and its replay is set aside, to be planned again at the next RETRO.
 */
const unmeasuredTrial = (
  k: Kernel,
  h: RunHandle,
  t: TrialRef,
  action: string | undefined,
  reason: string,
): void => {
  appendRow(k, h.state.id, {
    kind: "unmeasured",
    replay: t.replay,
    n: t.n,
    reason: reason.slice(0, 500),
  });
  if (action !== undefined) dropTrialCheckout(k, h.state.id, t, action);
  const proposal = readReplayPlan(k, h.state.id)?.replays[t.replay]?.proposal ?? "?";
  k.notice(
    `replay trial ${key(t)} of run ${h.state.id} measured nothing (${reason}); the replay of proposal ${proposal} waits for the next RETRO`,
  );
};

/**
 * A trial the dispatcher refused to hand out (the Lead session's sandbox, the platform, an arm
 * that cannot run as planned): it measured nothing, so its replay waits for the next RETRO
 * instead of asking the human (a replay changes nothing).
 */
export const refuseTrial = (k: Kernel, h: RunHandle, ref: TrialRef, reason: string): void => {
  // a headless trial refused after its dispatch has a checkout to drop
  const action = progressOf(k, h.state.id)?.dispatched.get(key(ref));
  unmeasuredTrial(k, h, ref, action, `it was not run: ${reason}`);
};

/**
 * Makes a trial's clean checkout in a fresh work tree outside the user's repo, then records its
 * dispatch (callers then hand the step out with the checkout as its working directory). A
 * `preparing` row comes first, so a crash in between leaves a checkout that `stepReplays`
 * removes; the `dispatched` row only once the checkout exists, so an action id a trial never ran
 * is no trial's. Returns the checkout's absolute path, or `null` when it could not be made: the
 * trial then measured nothing.
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
    unmeasuredTrial(
      k,
      h,
      ref,
      undefined,
      `no directory for its checkout: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  const checkout = checkoutAt(k, h.state.id, ref, action, ref.base, tree);
  const row = { replay: ref.replay, n: ref.n, action, tree };
  appendRow(k, h.state.id, { kind: "preparing", ...row });
  try {
    await createReplayCheckout(k.deps.repoRoot, checkout);
  } catch (error) {
    unmeasuredTrial(
      k,
      h,
      ref,
      action,
      `no checkout at ${ref.base.slice(0, 12)}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
  appendRow(k, h.state.id, { kind: "dispatched", ...row });
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
  t: TrialRef & { readonly trial: LookbackReplayTrial },
): Promise<string> => {
  const checkout = trialCheckout(k, h.state.id, t, run.action_id, t.trial.base);
  if (checkout === undefined) throw new Error(`replay trial ${run.action_id} has no checkout`);
  try {
    return await snapshotReplayCheckout(checkout, `vtc: replay trial ${run.action_id}`);
  } catch (error) {
    if (error instanceof ReplayCheckoutTamperedError) recordTrialTamper(k, h, run.action_id, error);
    throw error;
  }
};

/**
 * The files a trial's grade protects by checksum at its base, as its recorded round did (§7.3):
 * the recorded task's QA-owned acceptance tests and the protected configs of the `gates.yml`
 * committed at the base.
 */
export const trialProtectedFiles = async (
  k: Kernel,
  trial: Pick<LookbackReplayTrial, "base" | "protectedPaths">,
): Promise<{ path: string; sha256: string }[]> => {
  const out = new Map<string, string>();
  for (const path of trial.protectedPaths ?? []) {
    const bytes = await k.deps.git.readFileAtCommit(trial.base, path);
    if (bytes !== undefined) out.set(path, createHash("sha256").update(bytes).digest("hex"));
  }
  for (const [path, sum] of await protectedConfigsAt(k, trial.base)) out.set(path, sum);
  return [...out.entries()].map(([path, sum]) => ({ path, sha256: sum }));
};

/** The recorded task whose hidden acceptance tests a trial's grade copies in (`<run>:<task>`). */
const hiddenTaskOf = (trial: LookbackReplayTrial): string | undefined => {
  const task = trial.task.split(":").at(-1);
  return TaskIdSchema.safeParse(task).success ? task : undefined;
};

/** What a grade came to: a measurement, or nothing measured with the reason. */
type GradeOutcome = { readonly passed: boolean } | { readonly unmeasured: string };

/**
 * Grades an accepted trial through the Gate Runner (a job): its `base..head` against the gates
 * committed at its base and the recorded pack's scope, with the recorded task's protected files
 * and hidden acceptance tests as in its round, once the head's objects are in the user's repo (the
 * Gate Runner's git reads that repo), in a clean verification checkout of the head made for the
 * grade and removed after it, like every gate run (`runGates`): never in the trial's own tree,
 * where what the role left ignored (dependencies, build output, `.env`) would feed the gates. A
 * gate run that cannot run, or reports `infra_error`, measured nothing. The trial's checkout is
 * removed after.
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
    const checkout = trialCheckout(k, h.state.id, t, action, t.trial.base);
    let outcome: GradeOutcome;
    try {
      if (checkout === undefined) throw new Error("its dispatch names no checkout");
      const gates = await gatesAt(k, t.trial.base);
      if (gates === null) throw new Error(`no committed gates.yml at ${t.trial.base.slice(0, 12)}`);
      if (lookback?.gradeTrial === undefined) throw new Error("no Lookback grader is wired");
      const grade = lookback.gradeTrial.bind(lookback);
      await exposeReplayHead(k.deps.repoRoot, checkout, head);
      const hidden = hiddenTaskOf(t.trial);
      const request: Omit<GateRunRequestInput, "checkout"> = {
        run: h.state.id,
        reason: "round",
        scope: "affected",
        base: t.trial.base,
        head,
        files_scope: t.trial.pack.files_scope,
        protected: await trialProtectedFiles(k, t.trial),
        req_tags: t.trial.pack.requirements.map((r) => r.id),
        ...(hidden === undefined ? {} : { include_hidden: true, hidden_tasks: [hidden] }),
        gates_config_hash: gates.sha256,
      };
      const verdict = await guardGateRun(k, h, `replay trial ${action}`, async () => {
        const clean = await k.deps.git.createCleanCheckout(head);
        try {
          return await grade(GateRunRequestSchema.parse({ ...request, checkout: clean }));
        } finally {
          await k.deps.git.removeCheckout(clean);
        }
      });
      outcome =
        verdict === "infra_error"
          ? { unmeasured: "its gate run reported infra_error" }
          : { passed: verdict === "pass" };
    } catch (error) {
      if (error instanceof ReplayCheckoutTamperedError) {
        // the role changed its checkout's git directory: its doing, so it did not pass
        const tampered = error;
        await k.serial(h, () => {
          recordTrialTamper(k, h, action, tampered);
          return Promise.resolve();
        });
        outcome = { passed: false };
      } else
        outcome = {
          unmeasured: `it could not be graded: ${error instanceof Error ? error.message : String(error)}`,
        };
    }
    await k.serial(h, () => {
      const progress = progressOf(k, h.state.id);
      if (progress !== null && settled(progress, key(t))) {
        dropCheckout(k, h.state.id, checkout);
        return Promise.resolve();
      }
      if ("unmeasured" in outcome) unmeasuredTrial(k, h, t, action, outcome.unmeasured);
      else {
        appendRow(k, h.state.id, {
          kind: "graded",
          replay: t.replay,
          n: t.n,
          passed: outcome.passed,
          tokens: tokensOf(h.state.roleRuns.get(action)),
        });
        dropCheckout(k, h.state.id, checkout);
      }
      return Promise.resolve();
    });
  });
};

/**
 * The next trial step, when no trial runs or waits for its grade, and the weekly window and budget
 * still allow one (else `stepReplays` stops the replays). Trials of a replay set aside are skipped.
 */
export const replaySteps = (k: Kernel, h: RunHandle): ReplayStep[] => {
  const progress = progressOf(k, h.state.id);
  if (progress === null || progress.deferred !== undefined) return [];
  // one trial at a time: one is in flight, its grade is not in yet, or `stepReplays` has yet to
  // settle one that never got its role run
  for (const id of [...progress.dispatched.keys(), ...progress.preparing.keys()])
    if (!settled(progress, id)) return [];
  if (replayWait(k, h) !== null) return [];
  for (const [replay, r] of progress.plan.replays.entries()) {
    if (progress.setAside.has(replay) || progress.finished.has(replay)) continue;
    for (const [n, trial] of r.trials.entries()) {
      const id = key({ replay, n });
      if (progress.dispatched.has(id) || settled(progress, id)) continue;
      return [
        {
          key: `retro:replay:${id}`,
          role: trial.role,
          ...(trial.mode === undefined ? {} : { mode: trial.mode }),
          ...(trial.pack.subject === undefined ? {} : { subject: trial.pack.subject }),
          note: `Lookback replay (§13 step 3) of proposal ${r.proposal}: work exactly as the task pack says; this run is graded by the gates and changes nothing outside its checkout.`,
          purpose: "lookback_replay",
          replay: {
            replay,
            n,
            prompt: trial.prompt,
            pack: trial.pack,
            base: trial.base,
            ...(trial.protectedPaths === undefined ? {} : { protectedPaths: trial.protectedPaths }),
          },
        },
      ];
    }
  }
  return [];
};

/**
 * RETRO's replay stage (callers hold the run's lock): plans the replays once, settles the trials
 * that ended without a result or never got their role run, re-grades an accepted trial whose
 * grade a restart lost, writes each replay's result once its trials are graded (a replay set aside
 * waits for the next RETRO), and stops the replays when the weekly window or the budget no longer
 * allows a trial ({@link deferReplays}). `done` once nothing is left to run.
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
  // a checkout made, or being made, when the engine stopped before the dispatch
  for (const [id, action] of progress.preparing)
    if (!settled(progress, id))
      unmeasuredTrial(k, h, refOf(id), action, "the engine stopped before it was handed out");
  let busy = false;
  for (const [id, action] of progress.dispatched) {
    if (settled(progress, id)) continue;
    const ref = refOf(id);
    const record = h.state.roleRuns.get(action);
    // never handed out (the engine stopped before its role run), or its action went to a later trial
    if (record === undefined || progress.owner.get(action) !== id) {
      unmeasuredTrial(k, h, ref, action, "it was never handed out");
      continue;
    }
    if (ended(record)) {
      // the role's own failure did not pass; a run stopped or interrupted measured nothing
      if (countsAsFailure(record)) failTrial(k, h, ref, action);
      else
        unmeasuredTrial(
          k,
          h,
          ref,
          action,
          `its role run was ${record.status === "failed" ? "stopped" : record.status}`,
        );
      continue;
    }
    busy = true;
    const trial = progress.plan.replays[ref.replay]?.trials[ref.n];
    if (
      record.status === "submitted" &&
      record.head !== undefined &&
      trial !== undefined &&
      !k.isRunning(`replay-grade:${run}:${id}`)
    )
      startTrialGrade(k, h, { ...ref, trial }, action, record.head);
  }
  if (busy) return "busy";
  const lookback = k.lookbackRetro();
  // the rows this pass appended (settled trials, set-aside replays)
  const now = progressOf(k, run) ?? progress;
  for (const [index, replay] of now.plan.replays.entries()) {
    if (now.finished.has(index) || now.setAside.has(index)) continue;
    const outcomes = replay.trials.flatMap((_t, n) => {
      const o = now.graded.get(key({ replay: index, n }));
      return o === undefined ? [] : [o];
    });
    if (outcomes.length < replay.trials.length) {
      // stopped: the replays not yet graded wait for the next RETRO
      if (now.deferred !== undefined) continue;
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
