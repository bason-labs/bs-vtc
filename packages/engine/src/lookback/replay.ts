/**
 * The replay harness (spec §13 step 3; AD-21 rule 6). A replay re-runs a role on recorded tasks
 * with the baseline (arm `a`) and the candidate (arm `b`), k trials each, paired on the same tasks
 * and interleaved, plus an A/A run (baseline against baseline) for the noise floor when none is
 * cached for the baseline. Each trial is a role run with purpose `lookback_replay`
 * (`planDispatch`), in a clean checkout at the task's base with no refs past it; engine core
 * dispatches it and grades it through the `GateRunner` interface ({@link gradeTrial}).
 * `replayVerdict` decides; `inconclusive` reaches the human as such, never as improved.
 *
 * Tasks: the held-out failures of the baseline version (should improve) and held-out successes
 * (the regression set, which must not get worse beyond the A/A flip rate).
 */
import {
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  parsePersisted,
  planDispatch,
  ReplayResultSchema,
  replayVerdict,
  SlugSchema,
  splitForTrace,
  type Attribution,
  type DispatchMode,
  type DispatchPlan,
  type GateRunner,
  type GateRunRequest,
  type HostCapabilities,
  type HostId,
  type PromptVersionRef,
  type ReplayResult,
} from "@vtc/shared";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { readTextIfExists, writeAtomic } from "./files.js";
import { sameTarget, traceRef, type Trace } from "./traces.js";

/** Most tasks of each kind one replay runs (§13: 5–10 attributed failures). */
export const REPLAY_MAX_TASKS = 10;

export interface ReplayTask {
  /** The recorded dispatch the trial re-runs (its pack and base commit). */
  readonly trace: string;
  readonly run: string;
  readonly task: string;
  /** The task passed with the baseline: a regression-set task. */
  readonly regressionSet: boolean;
}

/** The held-out tasks a replay of `baseline` runs. */
export const replayTasks = (input: {
  readonly baseline: PromptVersionRef;
  readonly traces: readonly Trace[];
  readonly attributions: readonly Attribution[];
}): ReplayTask[] => {
  const failed = new Set(input.attributions.filter((a) => a.outcome === "failure").map(traceRef));
  const held = input.traces.filter(
    (t) =>
      t.task !== undefined &&
      t.prompt?.effective_sha256 === input.baseline.effective_sha256 &&
      sameTarget(t, input.baseline) &&
      t.end?.kind === "submitted" &&
      splitForTrace(t.trace) === "holdout",
  );
  const pick = (regressionSet: boolean): ReplayTask[] => {
    const seen = new Set<string>();
    const tasks: ReplayTask[] = [];
    for (const t of held) {
      if (failed.has(traceRef(t)) === regressionSet || t.task === undefined) continue;
      const key = `${t.run}:${t.task}`;
      if (seen.has(key)) continue;
      seen.add(key);
      tasks.push({ trace: t.trace, run: t.run, task: t.task, regressionSet });
    }
    return tasks.slice(0, REPLAY_MAX_TASKS);
  };
  return [...pick(false), ...pick(true)];
};

export interface ReplayTrial {
  readonly task: ReplayTask;
  /** `a` baseline, `b` candidate, `aa` the second baseline arm of the A/A run. */
  readonly arm: "a" | "b" | "aa";
  /** 1-based. */
  readonly trial: number;
  readonly prompt: PromptVersionRef;
  readonly purpose: "lookback_replay";
}

/** The trials of a replay, interleaved so no arm runs in a block (trial order alternates a/b). */
export const planReplayTrials = (input: {
  readonly tasks: readonly ReplayTask[];
  readonly baseline: PromptVersionRef;
  readonly candidate: PromptVersionRef;
  /** True when no A/A flip rate is cached for the baseline. */
  readonly withAa: boolean;
  readonly k?: number;
}): ReplayTrial[] => {
  const k = input.k ?? LOOKBACK_LIMITS.replayTrials;
  const trials: ReplayTrial[] = [];
  for (let trial = 1; trial <= k; trial += 1) {
    for (const task of input.tasks) {
      const pair: ReplayTrial[] = [
        { task, arm: "a", trial, prompt: input.baseline, purpose: "lookback_replay" },
        { task, arm: "b", trial, prompt: input.candidate, purpose: "lookback_replay" },
      ];
      trials.push(...(trial % 2 === 0 ? pair.reverse() : pair));
      if (input.withAa)
        trials.push({ task, arm: "aa", trial, prompt: input.baseline, purpose: "lookback_replay" });
    }
  }
  return trials;
};

/** How replays run in this project (AD-17): the Lead dispatches them, or the engine, or neither. */
export const replayDispatchPlan = (
  mode: DispatchMode,
  capabilities: Pick<HostCapabilities, "subagents" | "headless">,
  leadHost?: HostId,
): DispatchPlan => planDispatch("lookback_replay", mode, capabilities, leadHost);

/** Grades one trial through the Gate Runner (AD-21 rule 5): it passed when the gates pass. */
export const gradeTrial = async (runner: GateRunner, request: GateRunRequest): Promise<boolean> =>
  (await runner.run(request)).verdict === "pass";

const passRate = (trials: readonly boolean[]): number =>
  trials.length === 0 ? 0 : trials.filter(Boolean).length / trials.length;

/** The A/A flip rate: the mean per-task pass-rate difference between two baseline arms. */
export const aaFlipRate = (
  pairs: readonly { readonly a: readonly boolean[]; readonly aa: readonly boolean[] }[],
): number =>
  pairs.length === 0
    ? 0
    : pairs.reduce((sum, p) => sum + Math.abs(passRate(p.a) - passRate(p.aa)), 0) / pairs.length;

/** The relative token change of the candidate, in percent of the baseline's mean. */
export const tokensDeltaPct = (a: readonly number[], b: readonly number[]): number => {
  const mean = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const base = mean(a);
  return base === 0 ? 0 : ((mean(b) - base) / base) * 100;
};

/** The replay's result, decided by `replayVerdict`. */
export const finishReplay = (input: {
  readonly proposal: string;
  readonly baseline: PromptVersionRef;
  readonly candidate: PromptVersionRef;
  readonly graderBundleSha: string;
  readonly k: number;
  readonly perTask: readonly {
    readonly task: string;
    readonly a: readonly boolean[];
    readonly b: readonly boolean[];
    readonly regressionSet: boolean;
  }[];
  readonly aaFlipRate: number;
  readonly tokensDeltaPct: number;
  readonly now: Date;
}): ReplayResult => {
  const decided = replayVerdict(input.perTask, input.aaFlipRate, input.tokensDeltaPct);
  return ReplayResultSchema.parse({
    v: 1,
    proposal: input.proposal,
    role: input.baseline.role,
    ...(input.baseline.mode === undefined ? {} : { mode: input.baseline.mode }),
    host: input.baseline.host,
    baseline: input.baseline.effective_sha256,
    candidate: input.candidate.effective_sha256,
    grader_bundle_sha: input.graderBundleSha,
    k: input.k,
    per_task: input.perTask.map((t) => ({
      task: t.task,
      a: [...t.a],
      b: [...t.b],
      regression_set: t.regressionSet,
    })),
    aa_flip_rate: input.aaFlipRate,
    sign_test: decided.signTest,
    tokens_delta_pct: input.tokensDeltaPct,
    verdict: decided.verdict,
    finished_at: input.now.toISOString(),
  });
};

/** Repo-relative path of a replay result. */
export const replayPath = (proposal: string): string =>
  `${LOOKBACK_REPO.replaysDir}/${SlugSchema.parse(proposal)}.json`;

/** Writes the result and returns the `lookback.replay_finished` draft. */
export const writeReplayResult = async (
  projectRoot: string,
  result: ReplayResult,
): Promise<LookbackEventDraft> => {
  const path = replayPath(result.proposal);
  await writeAtomic(
    join(projectRoot, path),
    `${JSON.stringify(ReplayResultSchema.parse(result), null, 2)}\n`,
  );
  return lookbackEvent("lookback.replay_finished", {
    proposal: result.proposal,
    verdict: result.verdict,
    path,
  });
};

/**
 * The A/A flip rate cached for a baseline (the newest replay of the same role, mode, host and
 * baseline under the same grader bundle), or `undefined`: then the replay runs its own A/A arm.
 */
export const cachedAaFlipRate = async (
  projectRoot: string,
  baseline: PromptVersionRef,
  graderBundleSha: string,
): Promise<number | undefined> => {
  let names: string[];
  try {
    names = await readdir(join(projectRoot, LOOKBACK_REPO.replaysDir));
  } catch {
    return undefined;
  }
  let best: ReplayResult | undefined;
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const text = await readTextIfExists(join(projectRoot, LOOKBACK_REPO.replaysDir, name));
    if (text === undefined) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    const parsed = parsePersisted(ReplayResultSchema, raw);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (
      r.baseline === baseline.effective_sha256 &&
      sameTarget(r, baseline) &&
      r.grader_bundle_sha === graderBundleSha &&
      (best === undefined || r.finished_at > best.finished_at)
    ) {
      best = r;
    }
  }
  return best?.aa_flip_rate;
};
