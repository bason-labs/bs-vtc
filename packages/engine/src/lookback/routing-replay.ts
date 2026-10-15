/**
 * Tier replays (D-cn; spine §5 reading 247(6)): the evidence a routing change carries beside the
 * scorecard. A tier replay re-runs the held-out tasks of the change's current cell
 * (`routingReplayTasks`) with the same prompt version on both arms, arm `a` on the tier the table
 * starts the cell on now (`from`) and arm `b` on the proposed one (`to`), k trials each
 * (`LOOKBACK_LIMITS.replayTrials`), paired and interleaved as a prompt replay is
 * ({@link planRoutingReplayTrials}). Its id is `routingReplayId(role, size, risk, from, to)`, the
 * `ReplayTrialRef.proposal` of its trials and the name of its result.
 *
 * - **Ledger.** Its graded trials live in the replay ledger under the VTC home
 *   (`LOOKBACK_HOME.replayTrialsFile`, which no role may write) with the arm's `tier`, and the one
 *   prompt version as both `baseline` and `candidate` ({@link recordRoutingReplayTrial}), so a
 *   replay continues across RETROs within the D-cq pace, and a new prompt version or grader bundle
 *   starts it over. A row counts only for the trial of its arm's tier; that tier is the one the
 *   caller names, not one the ledger saw the trial run on, so where each trial ran comes from the
 *   trials' own events ({@link routingReplayTrialTiers}).
 * - **Grade.** Once every planned trial has a row (and the routing step has seen each one's
 *   dispatch on its arm's tier), {@link assembleRoutingReplay} grades it like a
 *   prompt replay: `replayVerdict`'s paired sign test of arm `b` against arm `a`, with the A/A noise
 *   floor cached for the prompt (0 when none: a tier replay runs no A/A arm), `tokens_delta_pct`
 *   from the ledger's tokens and `cost_delta_pct` from the trials' reported costs where every trial
 *   of both arms has one ({@link routingReplayCosts}); its isolation is the weakest any trial ran
 *   under. The result is decided from the ledger every time, never read back from the repo, where
 *   {@link writeRoutingReplayResult} keeps it for people (`routingReplayPath`).
 */
import {
  LOOKBACK_LIMITS,
  replayVerdict,
  RoutingReplayResultSchema,
  routingReplayPath,
  isEventOfType,
  readEventData,
  type HostId,
  type ModelTier,
  type PromptVersionRef,
  type ReplayGrader,
  type ReplayInfraOutcome,
  type RoutingReplayResult,
  type VtcEvent,
} from "@vtc/shared";
import { join } from "node:path";
import { readRoleWrittenText, writeRepoFileAtomic } from "./files.js";
import {
  recordReplayInfra,
  recordReplayTrial,
  replayTrialKey,
  type ReplayLedgerScope,
  type ReplayTrialId,
  type ReplayTrialRow,
} from "./replay-ledger.js";
import { replayIsolation, replayTaskKey, tokensDeltaPct, type ReplayTask } from "./replay.js";

/** One trial of a tier replay: its arm's tier and the recorded dispatch it runs again. */
export interface RoutingReplayTrial extends ReplayTrialId {
  readonly arm: "a" | "b";
  /** The arm's tier (`ReplayTrialRef.tier`): `from` for arm `a`, `to` for arm `b`. */
  readonly tier: ModelTier;
  /** The task passed on its start tier: a regression-set task. */
  readonly regressionSet: boolean;
  /** The recorded dispatch (`role.dispatched.action_id`) the trial re-runs, and its run. */
  readonly trace: string;
  readonly run: string;
}

/**
 * Pure: a tier replay's trials, each task's pair interleaved so no arm runs in a block (the order
 * of a pair alternates with the trial number), arm `a` on `from` and arm `b` on `to`.
 */
export const planRoutingReplayTrials = (input: {
  readonly tasks: readonly ReplayTask[];
  readonly from: ModelTier;
  readonly to: ModelTier;
  readonly k?: number;
}): RoutingReplayTrial[] => {
  const k = input.k ?? LOOKBACK_LIMITS.replayTrials;
  const trials: RoutingReplayTrial[] = [];
  for (let trial = 1; trial <= k; trial += 1) {
    for (const task of input.tasks) {
      const of = (arm: "a" | "b"): RoutingReplayTrial => ({
        task: replayTaskKey(task),
        arm,
        trial,
        tier: arm === "a" ? input.from : input.to,
        regressionSet: task.regressionSet,
        trace: task.trace,
        run: task.run,
      });
      trials.push(...(trial % 2 === 0 ? [of("b"), of("a")] : [of("a"), of("b")]));
    }
  }
  return trials;
};

/**
 * A tier replay's trials to launch in this RETRO, as the routing step hands them to engine core:
 * the replay, the one prompt version both arms run, how its trials are graded, the trials (each
 * with its arm's tier and the recorded dispatch it re-runs) and how many still wait after them.
 */
export interface RoutingReplayLaunch {
  /** `routingReplayId`: each trial's `ReplayTrialRef.proposal`. */
  readonly proposal: string;
  /** The routing cell, `routing.<role>.<size>.<risk>`. */
  readonly subject: string;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  readonly prompt: PromptVersionRef;
  readonly grader: ReplayGrader;
  /** In plan order, whole pairs. */
  readonly trials: readonly RoutingReplayTrial[];
  /** Ungraded trials left for a later RETRO. */
  readonly remaining: number;
}

/** The ledger scope of a tier replay: its one prompt version is both baseline and candidate. */
export const routingReplayScope = (input: {
  readonly repoKey: string;
  readonly proposal: string;
  /** The prompt version's `effective_sha256`. */
  readonly prompt: string;
  readonly graderBundleSha: string;
}): ReplayLedgerScope => ({
  repoKey: input.repoKey,
  proposal: input.proposal,
  baseline: input.prompt,
  candidate: input.prompt,
  graderBundleSha: input.graderBundleSha,
});

/** What one tier replay trial came to: a grade, or an attempt that measured nothing. */
export type RoutingTrialRecord =
  | {
      readonly kind: "graded";
      readonly passed: boolean;
      readonly tokens: number;
      readonly readDenied: boolean;
    }
  | { readonly kind: "unmeasured"; readonly outcome: ReplayInfraOutcome };

/**
 * Keeps one tier replay trial's outcome in the replay ledger (D-cg, reading 247(6)): the arm's tier
 * on the row, and the prompt version as both baseline and candidate. The row says which trial it
 * grades, not where it ran: the routing step grades a replay only when the trials' events show
 * each ran on its arm's tier ({@link routingReplayTrialTiers}).
 */
export const recordRoutingReplayTrial = async (
  vtcHome: string,
  input: {
    readonly repoKey: string;
    readonly proposal: string;
    /** The prompt version's `effective_sha256`. */
    readonly prompt: string;
    readonly graderBundleSha: string;
    readonly trial: Pick<RoutingReplayTrial, "task" | "arm" | "trial" | "tier">;
    readonly record: RoutingTrialRecord;
    readonly at: Date;
  },
): Promise<void> => {
  const identity = {
    repo_key: input.repoKey,
    proposal: input.proposal,
    baseline: input.prompt,
    candidate: input.prompt,
    task: input.trial.task,
    arm: input.trial.arm,
    trial: input.trial.trial,
    grader_bundle_sha: input.graderBundleSha,
    tier: input.trial.tier,
  };
  const at = input.at.toISOString();
  if (input.record.kind === "graded")
    await recordReplayTrial(vtcHome, {
      ...identity,
      passed: input.record.passed,
      tokens: Math.max(0, Math.round(input.record.tokens)),
      read_denied: input.record.readDenied,
      graded_at: at,
    });
  else await recordReplayInfra(vtcHome, { ...identity, outcome: input.record.outcome, at });
};

/**
 * Pure: the cost each trial of tier replay `proposal` reported, by trial key (`replayTrialKey`),
 * from the replay trials' own events (`role.dispatched.replay`, `role.submitted` `cost_usd`; `null`
 * when the host reported none). A trial dispatched more than once keeps its last submission.
 */
export const routingReplayCosts = (
  events: readonly VtcEvent[],
  proposal: string,
): Map<string, number | null> => {
  const trials = new Map<string, string>();
  const costs = new Map<string, number | null>();
  for (const event of events) {
    if (isEventOfType(event, "role.dispatched")) {
      const { replay, action_id } = readEventData(event);
      if (replay?.proposal === proposal)
        trials.set(`${event.run}:${action_id}`, replayTrialKey(replay));
      continue;
    }
    if (!isEventOfType(event, "role.submitted")) continue;
    const key = trials.get(`${event.run}:${readEventData(event).action_id}`);
    if (key === undefined) continue;
    costs.set(key, typeof event.cost_usd === "number" ? event.cost_usd : null);
  }
  return costs;
};

/** Where the trials of one tier replay ran, by trial key (`replayTrialKey`). */
export interface RoutingReplayTrialTiers {
  /** Trials with a dispatch on their arm's tier, unclamped and on the tier's own model. */
  readonly onTier: ReadonlySet<string>;
  /** Trials with a dispatch anywhere else (see {@link routingReplayTrialTiers}). */
  readonly offTier: ReadonlySet<string>;
}

/**
 * Pure: where the trials of tier replay `proposal` ran, from the replay trials' own events
 * (`role.dispatched` with `replay.proposal`). A dispatch is off its arm's tier when its
 * `replay.tier` is absent (it ran on the recorded tier, as a prompt replay does), when it reports no
 * `tier` (a tier replay is 5.7.0 or later, so a dispatch without one is an anomaly, never trusted),
 * when its `tier` differs from the arm's, when the project's bounds moved it (`tier_clamped`) or
 * when it ran on the host's default model (`model_fallback`, D-cx). Such a trial measures another
 * tier than the one its arm compares. The ledger cannot tell (its row carries the arm's tier the
 * caller names), so these events are what a tier replay is graded on: a trial with no on-tier
 * dispatch among them is not known to have run on its arm's tier.
 */
export const routingReplayTrialTiers = (
  events: readonly VtcEvent[],
  proposal: string,
): RoutingReplayTrialTiers => {
  const onTier = new Set<string>();
  const offTier = new Set<string>();
  for (const event of events) {
    if (!isEventOfType(event, "role.dispatched")) continue;
    const data = readEventData(event);
    const ref = data.replay;
    if (ref?.proposal !== proposal) continue;
    const on =
      ref.tier !== undefined &&
      data.tier === ref.tier &&
      data.tier_clamped !== true &&
      data.model_fallback === undefined;
    (on ? onTier : offTier).add(replayTrialKey(ref));
  }
  return { onTier, offTier };
};

const meanOf = (xs: readonly number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;

/** Arm `b`'s mean cost against arm `a`'s, in percent; `null` unless every trial is priced. */
const costDeltaPct = (
  planned: readonly RoutingReplayTrial[],
  costs: ReadonlyMap<string, number | null> | undefined,
): number | null => {
  if (costs === undefined) return null;
  const arms: { a: number[]; b: number[] } = { a: [], b: [] };
  for (const t of planned) {
    const cost = costs.get(replayTrialKey(t));
    if (typeof cost !== "number") return null;
    arms[t.arm].push(cost);
  }
  const [a, b] = [meanOf(arms.a), meanOf(arms.b)];
  if (a === 0) return b === 0 ? 0 : null;
  return ((b - a) / a) * 100;
};

/**
 * Pure: the graded tier replay once the ledger holds a row of the arm's tier for every planned
 * trial, or how many are still missing. A trial planned twice counts once.
 */
export const assembleRoutingReplay = (input: {
  /** `routingReplayId`. */
  readonly id: string;
  /** `routing.<role>.<size>.<risk>`. */
  readonly subject: string;
  readonly target: { readonly role: string; readonly mode?: string; readonly host: HostId };
  /** The prompt version both arms ran (`effective_sha256`). */
  readonly prompt: string;
  readonly tiers: { readonly a: ModelTier; readonly b: ModelTier };
  readonly grader: ReplayGrader;
  readonly graderBundleSha: string;
  readonly planned: readonly RoutingReplayTrial[];
  /** The ledger's graded trials of the replay's scope, by trial key. */
  readonly rows: ReadonlyMap<string, ReplayTrialRow>;
  /** The A/A noise floor cached for the prompt version; default 0. */
  readonly aaFlipRate?: number;
  /** Each trial's reported cost (`routingReplayCosts`); absent: the cost is unknown. */
  readonly costs?: ReadonlyMap<string, number | null>;
  readonly now: Date;
}):
  | { readonly complete: false; readonly missing: number }
  | { readonly complete: true; readonly result: RoutingReplayResult; readonly trials: number } => {
  const seen = new Set<string>();
  const planned = input.planned.filter((t) => {
    const key = replayTrialKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const rowOf = (t: RoutingReplayTrial): ReplayTrialRow | undefined => {
    const row = input.rows.get(replayTrialKey(t));
    return row?.tier === t.tier ? row : undefined;
  };
  const missing = planned.filter((t) => rowOf(t) === undefined).length;
  if (planned.length === 0 || missing > 0) return { complete: false, missing };
  const tasks = new Map<string, { a: boolean[]; b: boolean[]; regressionSet: boolean }>();
  const tokens: { a: number[]; b: number[] } = { a: [], b: [] };
  const readDenied: boolean[] = [];
  let k = 1;
  for (const t of planned) {
    const row = rowOf(t);
    if (row === undefined) continue;
    const entry = tasks.get(t.task) ?? { a: [], b: [], regressionSet: t.regressionSet };
    entry[t.arm].push(row.passed);
    tasks.set(t.task, entry);
    tokens[t.arm].push(row.tokens);
    readDenied.push(row.read_denied);
    k = Math.max(k, t.trial);
  }
  const perTask = [...tasks].map(([task, r]) => ({ task, ...r }));
  const tokensDelta = tokensDeltaPct(tokens.a, tokens.b);
  const decided = replayVerdict(perTask, input.aaFlipRate ?? 0, tokensDelta);
  const result = RoutingReplayResultSchema.parse({
    v: 1,
    id: input.id,
    subject: input.subject,
    role: input.target.role,
    ...(input.target.mode === undefined ? {} : { mode: input.target.mode }),
    host: input.target.host,
    prompt: input.prompt,
    tiers: { a: input.tiers.a, b: input.tiers.b },
    grader_bundle_sha: input.graderBundleSha,
    grader: input.grader,
    k,
    per_task: perTask.map((t) => ({
      task: t.task,
      a: t.a,
      b: t.b,
      regression_set: t.regressionSet,
    })),
    sign_test: decided.signTest,
    tokens_delta_pct: tokensDelta,
    cost_delta_pct: costDeltaPct(planned, input.costs),
    verdict: decided.verdict,
    isolation: replayIsolation(readDenied),
    finished_at: input.now.toISOString(),
  });
  return { complete: true, result, trials: planned.length };
};

/** Far above any result written here; a larger file there is not one. */
const RESULT_MAX_BYTES = 256 * 1024;

/** The result without its time, to tell a new grade from the one already written. */
const sameGrade = (text: string | undefined, result: RoutingReplayResult): boolean => {
  if (text === undefined) return false;
  try {
    const parsed = RoutingReplayResultSchema.safeParse(JSON.parse(text) as unknown);
    if (!parsed.success) return false;
    return (
      JSON.stringify({ ...parsed.data, finished_at: "" }) ===
      JSON.stringify({ ...result, finished_at: "" })
    );
  } catch {
    return false;
  }
};

/**
 * Writes a graded tier replay at `routingReplayPath(result.id)` (git-tracked, for people; the
 * routing step decides from the ledger, never from this file). A result that only differs from the
 * one already there by its time is not written again, so a later RETRO does not churn the file; the
 * one there is read without following a symlink and within a size cap (`readRoleWrittenText`), and
 * anything else there is replaced.
 * Returns the repo-relative path and whether it was written.
 */
export const writeRoutingReplayResult = async (
  projectRoot: string,
  result: RoutingReplayResult,
): Promise<{ readonly path: string; readonly written: boolean }> => {
  const path = routingReplayPath(result.id);
  const full = join(projectRoot, path);
  // the path is in the repo: a symlink, a device or an oversized file there is never the result
  const existing = await readRoleWrittenText(full, RESULT_MAX_BYTES);
  if (existing.kind === "text" && sameGrade(existing.text, result)) return { path, written: false };
  await writeRepoFileAtomic(
    projectRoot,
    path,
    `${JSON.stringify(RoutingReplayResultSchema.parse(result), null, 2)}\n`,
  );
  return { path, written: true };
};
