/**
 * The replay harness (spec §13 step 3; AD-21 rule 6). A replay re-runs a role on recorded tasks
 * with the baseline (arm `a`) and the candidate (arm `b`), k trials each, paired on the same tasks
 * and interleaved, plus an A/A run (baseline against baseline) for the noise floor when none is
 * cached for the baseline. Each trial is an engine-launched headless role run with purpose
 * `lookback_replay` (`planDispatch`, spine §5 reading 201), in a clean checkout at the task's base
 * with no refs past it. How a trial is graded is `replayGraderFor` (readings 201 and 202): a role
 * that changes files through the `GateRunner` interface ({@link gradeTrial}), a verdict role by
 * the verdict grader against the recorded outcome (`gradeVerdictTrial`). `replayVerdict` decides
 * (the sign test and the A/A floor are the same for both graders); `inconclusive` reaches the
 * human as such, never as improved. The result records its grader and its isolation
 * ({@link replayIsolation}, reading 178).
 *
 * Tasks: the held-out failures of the baseline version (should improve) and held-out successes
 * (the regression set, which must not get worse beyond the A/A flip rate), sampled at the replay
 * pace (D-cq, spine §5 reading 224; `lookbackPaceFor`: 6 + 6 by default). For a verdict role a
 * failure is a held-out dispatch whose recorded verdict disagrees with its recorded outcome
 * (`recordedOutcome`), a success one that agrees.
 */
import {
  AaNoiseRowSchema,
  LOOKBACK_HOME,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  parsePersisted,
  planDispatch,
  ReplayResultSchema,
  replayVerdict,
  SlugSchema,
  sha256Hex,
  type AaNoiseRow,
  type Attribution,
  type DispatchMode,
  type DispatchPlan,
  type GateRunner,
  type GateRunRequest,
  type HostCapabilities,
  type HostId,
  type LookbackPace,
  type PromptVersionRef,
  type ReplayGrader,
  type ReplayIsolation,
  type ReplayResult,
} from "@vtc/shared";
import { join } from "node:path";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { appendJsonLines, readJsonLines, writeRepoFileAtomic } from "./files.js";
import { isRoleFailure, trustedAttributions, type AttributionHistory } from "./attribution.js";
import { buildTraces, sameTarget, traceRef, traceSplit } from "./traces.js";
import { recordedOutcome, type ExpectedVerdict } from "./verdict-grader.js";

export interface ReplayTask {
  /** The recorded dispatch the trial re-runs (its pack and base commit). */
  readonly trace: string;
  readonly run: string;
  readonly task: string;
  /** The task passed with the baseline: a regression-set task. */
  readonly regressionSet: boolean;
  /**
   * A verdict-graded replay only: the verdict a trial must give to pass (the recorded outcome of
   * the replayed dispatch, `recordedOutcome`).
   */
  readonly expected?: ExpectedVerdict;
}

/** Longest `ReplayResult.per_task` key (`ReplayTrialRef.task`). */
const TASK_KEY_MAX = 100;

/**
 * Pure: a replay task's key, the `ReplayResult.per_task` key, the ledger's and the trial's
 * (`ReplayTrialRef.task`). `<run>:<task>` for a `gates` replay; `<run>:<subject>:<verdict>:<task>`
 * for a verdict replay, whose dispatches judge one acceptance criterion each, so two criteria of one
 * task are two replay tasks. The expected verdict is part of the key: the recorded outcome can
 * gain stronger evidence between two RETROs (the feature's PR merges or is reverted, a defect
 * escapes, a human labels the miss), and a trial graded against one expectation must never be
 * counted with one graded against another, nor a task's regression-set membership change under
 * its grades. A changed expectation is a new replay task, whose trials start over; the ledger's
 * rows under the old key are no longer planned, so they no longer count. The task id stays last,
 * after the last `:` (a run id and a task id hold no `:`).
 */
export const replayTaskKey = (
  t: Pick<ReplayTask, "run" | "task"> & { readonly expected?: ExpectedVerdict },
): string =>
  t.expected === undefined
    ? `${t.run}:${t.task}`
    : `${t.run}:${t.expected.subject}:${t.expected.verdict}:${t.task}`;

/**
 * Pure: the expected verdict a verdict replay task's key carries ({@link replayTaskKey}), or
 * `undefined` for a `gates` key. The verdict grader scores a trial against it, so a trial is graded
 * against the expectation it was planned with, whatever the history says by the time it ends.
 */
export const expectedOfTaskKey = (key: string): ExpectedVerdict | undefined => {
  const parts = key.split(":");
  if (parts.length < 4) return undefined;
  const verdict = parts.at(-2);
  if (verdict !== "pass" && verdict !== "fail") return undefined;
  return { subject: parts.slice(1, -2).join(":"), verdict };
};

/**
 * The held-out tasks a replay of `baseline` runs, each once ({@link replayTaskKey}). For the
 * `gates` grader (the default) the attributions decide which traces failed, checked against the
 * history first ({@link trustedAttributions}): a planted failure row must not move a held-out
 * success out of the regression set. For the `verdict` grader the recorded outcome decides, from
 * the log alone; a dispatch with none is not replayed. A task the baseline failed on is never also
 * in the regression set (a task with a failed round and a passed one is a failure to fix), so one
 * key never stands for both. The sample (the pace's failures, then its regression tasks) is the
 * first in log order, so it stays the same as the history grows and a replay the trial cap spreads
 * over several RETROs keeps its graded trials (D-cq: about 5 RETROs at the base cap).
 */
export const replayTasks = (
  input: AttributionHistory & {
    readonly baseline: PromptVersionRef;
    readonly attributions: readonly Attribution[];
    readonly grader?: ReplayGrader;
    /**
     * How many failures and regression tasks to sample (D-cq, `lookbackPaceFor` of the user's
     * config); default `LOOKBACK_LIMITS.replayFailureTasks` / `replayRegressionTasks`.
     */
    readonly pace?: Pick<LookbackPace, "failureTasks" | "regressionTasks">;
  },
): ReplayTask[] => {
  const held = buildTraces(input.history, input.lockedShaFor).filter(
    (t) =>
      t.task !== undefined &&
      t.prompt?.effective_sha256 === input.baseline.effective_sha256 &&
      sameTarget(t, input.baseline) &&
      t.end?.kind === "submitted" &&
      traceSplit(t) === "holdout",
  );
  // each held-out trace: whether the baseline failed on it and, for a verdict role, the verdict
  // a trial must give
  const judged: { trace: (typeof held)[number]; failed: boolean; expected?: ExpectedVerdict }[] =
    [];
  if (input.grader === "verdict") {
    for (const trace of held) {
      const outcome = recordedOutcome(input.history, trace);
      if (outcome === undefined) continue;
      judged.push({
        trace,
        failed: outcome.recorded !== outcome.expected,
        expected: { subject: outcome.subject, verdict: outcome.expected },
      });
    }
  } else {
    const trusted = trustedAttributions(input.attributions, input);
    const failed = new Set(trusted.filter(isRoleFailure).map(traceRef));
    for (const trace of held) judged.push({ trace, failed: failed.has(traceRef(trace)) });
  }
  const keyOf = (j: (typeof judged)[number]): string | undefined => {
    if (j.trace.task === undefined) return undefined;
    const key = replayTaskKey({
      run: j.trace.run,
      task: j.trace.task,
      ...(j.expected === undefined ? {} : { expected: j.expected }),
    });
    return key.length > TASK_KEY_MAX ? undefined : key;
  };
  // every key the baseline failed on, before the cap: none of them is a regression-set task
  const failedKeys = new Set(
    judged.flatMap((j) => {
      const key = keyOf(j);
      return j.failed && key !== undefined ? [key] : [];
    }),
  );
  const pick = (regressionSet: boolean): ReplayTask[] => {
    const seen = new Set<string>();
    const tasks: ReplayTask[] = [];
    for (const j of judged) {
      const key = keyOf(j);
      const { trace: t, failed, expected } = j;
      if (failed === regressionSet || t.task === undefined || key === undefined) continue;
      if (seen.has(key) || (regressionSet && failedKeys.has(key))) continue;
      seen.add(key);
      tasks.push({
        trace: t.trace,
        run: t.run,
        task: t.task,
        regressionSet,
        ...(expected === undefined ? {} : { expected }),
      });
    }
    return tasks.slice(
      0,
      regressionSet
        ? (input.pace?.regressionTasks ?? LOOKBACK_LIMITS.replayRegressionTasks)
        : (input.pace?.failureTasks ?? LOOKBACK_LIMITS.replayFailureTasks),
    );
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

/**
 * Pure (spine §5 readings 178 and 204): how well a replay's trials were kept from the user's current
 * tree, from what each trial's host reported (`SandboxProfile.enforced.readDeny`). `read_denied`
 * only when every trial ran with the repo's read deny enforced; a replay with no trial is
 * `paths_only`. A Codex trial is always `paths_only`: Codex has no per-path read deny (reading 82),
 * so its adapter reports the read deny as not enforced (engine code never branches on a host,
 * AD-1).
 */
export const replayIsolation = (readDenied: readonly boolean[]): ReplayIsolation =>
  readDenied.length > 0 && readDenied.every(Boolean) ? "read_denied" : "paths_only";

/**
 * The replay's result, decided by `replayVerdict`. It always records its grader (`gates` unless
 * given, reading 202) and its isolation (`paths_only` unless given, reading 178).
 */
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
  readonly grader?: ReplayGrader;
  /** The trials' isolation ({@link replayIsolation}). */
  readonly isolation?: ReplayIsolation;
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
    isolation: input.isolation ?? "paths_only",
    grader: input.grader ?? "gates",
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
  const text = `${JSON.stringify(ReplayResultSchema.parse(result), null, 2)}\n`;
  await writeRepoFileAtomic(projectRoot, path, text);
  // The file's hash, so `vtc lookback approve` can tell the engine's file from an edited one.
  return lookbackEvent("lookback.replay_finished", {
    proposal: result.proposal,
    verdict: result.verdict,
    path,
    sha256: sha256Hex(text),
  });
};

/**
 * The A/A noise floors the engine measured, under the VTC home (`LOOKBACK_HOME.aaNoiseFile`, which
 * no role may write: `WAVE3_HOME_WRITE_DENY`). Never read from the repo: `.vtc/lookback/replays/*.json` is
 * git-tracked, and a planted high `aa_flip_rate` would let a regression pass `replayVerdict`. A row
 * is per project (`repo_key`): a flip rate measured on one repository's tasks is no noise floor for
 * another's. The row shape is local until a contract carries it (a contract proposal).
 */
const aaNoisePath = (vtcHome: string): string => join(vtcHome, LOOKBACK_HOME.aaNoiseFile);

/** Records the A/A flip rate a replay measured with its own `aa` arm (call it only then). */
export const recordAaFlipRate = async (input: {
  readonly vtcHome: string;
  /** The project the replay ran on (`engineRepoKey`). */
  readonly repoKey: string;
  readonly baseline: PromptVersionRef;
  readonly graderBundleSha: string;
  readonly aaFlipRate: number;
  readonly now: Date;
}): Promise<void> => {
  await appendJsonLines(aaNoisePath(input.vtcHome), [
    AaNoiseRowSchema.parse({
      v: 1,
      repo_key: input.repoKey,
      role: input.baseline.role,
      ...(input.baseline.mode === undefined ? {} : { mode: input.baseline.mode }),
      host: input.baseline.host,
      baseline: input.baseline.effective_sha256,
      grader_bundle_sha: input.graderBundleSha,
      aa_flip_rate: input.aaFlipRate,
      measured_at: input.now.toISOString(),
    }),
  ]);
};

/**
 * The A/A flip rate cached for a baseline (the newest one the engine measured in the same project
 * for the same role, mode, host and baseline under the same grader bundle), or `undefined`: then
 * the replay runs its own A/A arm and {@link recordAaFlipRate} keeps the result.
 */
export const cachedAaFlipRate = async (input: {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly baseline: PromptVersionRef;
  readonly graderBundleSha: string;
}): Promise<number | undefined> => {
  const { baseline } = input;
  let best: AaNoiseRow | undefined;
  for (const value of await readJsonLines(aaNoisePath(input.vtcHome))) {
    const parsed = parsePersisted(AaNoiseRowSchema, value);
    if (!parsed.success) continue;
    const r = parsed.data;
    if (
      r.repo_key === input.repoKey &&
      r.baseline === baseline.effective_sha256 &&
      sameTarget(r, baseline) &&
      r.grader_bundle_sha === input.graderBundleSha &&
      (best === undefined || r.measured_at >= best.measured_at)
    ) {
      best = r;
    }
  }
  return best?.aa_flip_rate;
};
