/**
 * Lookback (spec §13; spine AD-21; Lead decision D-bb). New in contracts 4.5.0.
 *
 * - **Identity.** A prompt version is {@link effectivePromptSha} of the role's locked core and the
 *   editable section that ran. Compiled agents carry the locked core; the engine renders the
 *   pinned editable section first in the task pack, so a canary needs no reinstall (spine §5
 *   reading 102).
 * - **Trust.** Versions are immutable files under the VTC home; pins (`pins.yaml`) are user-level
 *   and only a human promotes (`vtc lookback approve|pin`, TTY-confirmed). The engine may only roll
 *   a canary back. Repo content never selects a prompt.
 * - **Statistics.** Proportions carry n and a Wilson interval; replays are paired with an A/A
 *   noise floor and an exact sign test; canaries split tasks by hash and roll back on a trigger
 *   once both arms have data. All of it is pure code here so the optimiser cannot edit it.
 */
import { z } from "zod";
import { sha256Hex } from "./helpers/fingerprint.js";
import { promptShaFor } from "./plugin-manifest.js";
import {
  DisciplineSchema,
  EvidenceSchema,
  FeatureIdSchema,
  GitShaSchema,
  HostIdSchema,
  IsoDateTimeSchema,
  RelPathSchema,
  RoleIdSchema,
  RunIdSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
} from "./primitives.js";

// ------------------------------------------------------------------- places

/** Lookback files under the VTC home (`~/.vtc/`); roles may not write them (`ROLE_DENIED_VTC`). */
export const LOOKBACK_HOME = {
  /** Immutable versions: `prompts/<role>[-<mode>]/<host>/<sha8>.md`. */
  promptsDir: "lookback/prompts",
  /** The pins file (`LookbackPins`, YAML). Only a human gesture promotes; the engine rolls back. */
  pinsFile: "lookback/pins.yaml",
  /**
   * The lock every writer of `pins.yaml` takes, the cli's gestures and the engine's
   * `auto_rollback` alike (spine §5 reading 128): created exclusively (`wx`) holding a token only
   * its taker knows; older than {@link LOOKBACK_PINS_LOCK_STALE_MS} it is stale and is taken over
   * by renaming it to a unique name (linked back if it turned out fresh); released only by the
   * holder whose token it still holds. The pins file itself is written to a temporary file and
   * renamed. New in 4.6.0.
   */
  pinsLock: "lookback/pins.lock",
  /**
   * The measured A/A flip rates (one JSON line per replay), under the VTC home so no role can
   * plant a noise floor (reading 128). New in 4.6.0.
   */
  aaNoiseFile: "lookback/aa-noise.jsonl",
  /**
   * The AI tiebreak answers the engine recorded, one {@link LookbackTiebreakRecord} per line.
   * Under the VTC home (never in a repo), so no role can plant one: an `ai_tiebreak` attribution
   * counts only when its `tiebreak_key` is here (spine §5 reading 137). New in 4.7.0.
   *
   * Writer path (4.10.0, spine §5 reading 175): only the engine writes it, and only through the
   * lookback module's writer, which the daemon hands to core (core never imports lookback, AD-13
   * rule 12). The writer appends one line per answer (`O_APPEND`, never a rewrite), creates the
   * file with mode `0600`, refuses a symlink at the path or its directory, and keys each record
   * with {@link lookbackTiebreakKey} of the `ai_tiebreak` attribution row it backs. Roles may not
   * write it (`ROLE_DENIED_VTC`: the VTC home's `lookback/**`). Readers parse each line with
   * `parsePersisted` and skip a line that does not parse.
   */
  tiebreaksFile: "lookback/tiebreaks.jsonl",
} as const;

/** When a `pins.lock` counts as stale ({@link LOOKBACK_HOME}`.pinsLock`). New in 4.6.0. */
export const LOOKBACK_PINS_LOCK_STALE_MS = 60_000;

/** Lookback files in the project (git-tracked, redacted, AD-7 rule 6). */
export const LOOKBACK_REPO = {
  /** The lookback role's write scope: `<role>/editable.md` and `<role>/proposal.json` (AD-14 r4). */
  proposalsDir: ".vtc/lookback/proposals",
  /** `<role>/<host>/<sha8>/scorecard.json` (§13). */
  scorecardsDir: ".vtc/lookback/scorecards",
  /** What Flow Studio lists (`ScorecardIndex`), read through the artifacts route. */
  scorecardIndex: ".vtc/lookback/scorecards/index.json",
  /** `<proposal>.json` (`ReplayResult`). */
  replaysDir: ".vtc/lookback/replays",
  /** One `Attribution` per line. */
  attributions: ".vtc/lookback/attributions.jsonl",
} as const;

/** Thresholds of the §13 loop. Engine code and tests read them from here only. */
export const LOOKBACK_LIMITS = {
  /** Attributed train-split failures a (role, host) needs before the lookback role runs. */
  minTrainFailures: 5,
  /** At most this many changes per proposal (§13 step 2). */
  maxProposalChanges: 3,
  /** Replay trials per task per arm (§13 step 3: k = 2–3). */
  replayTrials: 3,
  /** One-sided sign-test level for `improve`. */
  signTestAlpha: 0.05,
  /** Token rise that blocks `improve` and rolls a canary back, in percent (§13 step 6). */
  maxTokenRisePct: 20,
  /** Escalation or cap-hit rate ratio that rolls a canary back (§13 step 6: 2×). */
  rollbackRateRatio: 2,
  /** Rate triggers wait until both canary arms have this many dispatches. */
  minDispatchesPerArm: 5,
  /** Canary dispatches before a promotion may be proposed. */
  canaryWindow: 10,
  /** Below this n a scorecard metric shows "insufficient data". */
  minScorecardN: 10,
  /** Lookback starts only with this much of the weekly window left (§6.9). */
  minWeeklyRemainingPct: 30,
} as const;

// ----------------------------------------------------------------- identity

/** Pure: the prompt version that ran (AD-21 rule 1). */
export const effectivePromptSha = (locked: string, editable: string): string =>
  promptShaFor(`${locked.trim()}\n${editable.trim()}`);

/** One prompt version, as `role.dispatched` and every Lookback record name it. */
export const PromptVersionRefSchema = z.strictObject({
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  host: HostIdSchema,
  locked_sha256: Sha256HexSchema,
  editable_sha256: Sha256HexSchema,
  effective_sha256: Sha256HexSchema,
});
export type PromptVersionRef = z.infer<typeof PromptVersionRefSchema>;

/** Frontmatter of an immutable version file under {@link LOOKBACK_HOME}`.promptsDir` (§13). */
export const PromptVersionFrontmatterSchema = z.strictObject({
  v: z.literal(1),
  version: PromptVersionRefSchema,
  /** The version it was derived from; `null` for the compiled default. */
  parent: Sha256HexSchema.nullable(),
  proposal: SlugSchema.nullable(),
  /** The CHANGELOG entry (§13): hypothesis, trace ids, diff and evaluation. */
  changelog: z.strictObject({
    hypothesis: z.string().min(1).max(2000),
    trace_ids: z.array(SlugSchema).max(50).default([]),
    /** The replay result the approval rested on, relative to the project it came from. */
    evaluation: RelPathSchema.nullable(),
  }),
  created_at: IsoDateTimeSchema,
});
export type PromptVersionFrontmatter = z.infer<typeof PromptVersionFrontmatterSchema>;

// --------------------------------------------------------------------- pins

/** An `engineRepoKey`: how pins, A/A rows and tiebreak records name a project. Exported in 4.7.0. */
export const RepoKeySchema = z.string().regex(/^[a-f0-9]{16}$/, "expected an engineRepoKey");

const PinTargetSchema = z.strictObject({
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  host: HostIdSchema,
});

export const CanaryAssignmentSchema = z.literal("task_hash_50");

/** `~/.vtc/lookback/pins.yaml` (AD-21 rule 3). Read with `parsePersisted`. */
export const LookbackPinsSchema = z.strictObject({
  v: z.literal(1),
  projects: z
    .record(
      RepoKeySchema,
      z.strictObject({
        pins: z.array(PinTargetSchema.extend({ effective_sha256: Sha256HexSchema })).default([]),
        canaries: z
          .array(
            PinTargetSchema.extend({
              candidate: Sha256HexSchema,
              baseline: Sha256HexSchema,
              started_at: IsoDateTimeSchema,
              assignment: CanaryAssignmentSchema,
            }),
          )
          .default([]),
      }),
    )
    .default({}),
  /** Every gesture, newest last: the audit trail of who moved which pointer. */
  history: z
    .array(
      PinTargetSchema.extend({
        at: IsoDateTimeSchema,
        repo_key: RepoKeySchema,
        gesture: z.enum(["approve", "pin", "rollback", "auto_rollback", "promote"]),
        from: Sha256HexSchema.nullable(),
        to: Sha256HexSchema.nullable(),
        /** Only `auto_rollback` is the engine's; every other gesture is a human's. */
        by: z.enum(["human", "engine"]),
        reason: z.string().min(1).max(500),
      }).refine((h) => (h.by === "engine") === (h.gesture === "auto_rollback"), {
        message: "the engine only rolls back; every other gesture is a human's",
        path: ["by"],
      }),
    )
    .default([]),
});
export type LookbackPins = z.infer<typeof LookbackPinsSchema>;
export type LookbackPinsInput = z.input<typeof LookbackPinsSchema>;

/**
 * Pure: the canary arm of a task, 50/50 by hash of the repo key and task id, sticky across the
 * task's fix rounds (§13 step 5; a concurrent control, not a comparison with history).
 */
export const canaryArmFor = (repoKey: string, task: string): "candidate" | "baseline" =>
  Number.parseInt(sha256Hex(`${repoKey}:${task}`).slice(0, 8), 16) % 2 === 0
    ? "candidate"
    : "baseline";

/**
 * Pure: a trace's cross-run identity, `<run>:<action_id>` (spine §5 reading 128). Action ids
 * restart in every run (`a-1`), so a trace is named by its run and its action id together.
 * New in 4.6.0.
 */
export const lookbackTraceRef = (run: string, actionId: string): string =>
  `${RunIdSchema.parse(run)}:${SlugSchema.parse(actionId)}`;

/**
 * Pure: train (70%) or held-out (30%) split of a trace, by hash; the lookback role sees train
 * only. `traceId` is the run-qualified {@link lookbackTraceRef} (since 4.6.0): a bare action id
 * would put every run's `a-1` in the same split.
 */
export const splitForTrace = (traceId: string): "train" | "holdout" =>
  Number.parseInt(sha256Hex(traceId).slice(0, 8), 16) % 10 < 7 ? "train" : "holdout";

// ---------------------------------------------------------------- statistics

const lnFactorial = (n: number): number => {
  let sum = 0;
  for (let i = 2; i <= n; i += 1) sum += Math.log(i);
  return sum;
};

/**
 * Pure: exact one-sided sign test. P(X ≥ `wins`) for X ~ Binomial(`n`, 0.5), where `n` is the
 * number of discordant tasks and `wins` those the candidate won. `n = 0` gives 1.
 */
export const signTestOneSided = (n: number, wins: number): number => {
  if (!Number.isInteger(n) || !Number.isInteger(wins) || n < 0 || wins < 0 || wins > n) {
    throw new RangeError("expected integers 0 <= wins <= n");
  }
  if (n === 0) return 1;
  const lnN = lnFactorial(n);
  let p = 0;
  for (let k = wins; k <= n; k += 1) {
    p += Math.exp(lnN - lnFactorial(k) - lnFactorial(n - k) - n * Math.LN2);
  }
  return Math.min(1, p);
};

/** Pure: the Wilson score interval of `successes` out of `n` (z = 1.96 for 95%). */
export const wilsonInterval = (
  successes: number,
  n: number,
  z = 1.96,
): { readonly low: number; readonly high: number } => {
  if (n <= 0) return { low: 0, high: 1 };
  if (successes < 0 || successes > n) throw new RangeError("expected 0 <= successes <= n");
  const p = successes / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return { low: Math.max(0, centre - half), high: Math.min(1, centre + half) };
};

// ------------------------------------------------------------------ replays

export const ReplayVerdictSchema = z.enum(["improve", "regress", "no_change", "inconclusive"]);
export type ReplayVerdict = z.infer<typeof ReplayVerdictSchema>;

export interface ReplayTaskTrials {
  readonly task: string;
  /** Baseline trials (pass = true). */
  readonly a: readonly boolean[];
  /** Candidate trials. */
  readonly b: readonly boolean[];
  /** The task passed before (the regression set). */
  readonly regressionSet: boolean;
}

const passRate = (trials: readonly boolean[]): number =>
  trials.length === 0 ? 0 : trials.filter(Boolean).length / trials.length;

/**
 * Pure (AD-21 rule 6): the replay decision rule. Per task, the arm with the higher pass rate wins;
 * ties are not discordant.
 * - `regress`: a regression-set task drops by more than the A/A flip rate, or the baseline wins
 *   the sign test;
 * - `improve`: the candidate wins the sign test (p < 0.05) and tokens rise by at most 20%;
 * - `no_change`: no discordant task;
 * - `inconclusive` otherwise; it reaches the human as inconclusive, never as improved.
 */
export const replayVerdict = (
  tasks: readonly ReplayTaskTrials[],
  aaFlipRate: number,
  tokensDeltaPct: number,
): {
  readonly verdict: ReplayVerdict;
  readonly signTest: { readonly n_discordant: number; readonly wins_b: number; readonly p: number };
} => {
  let winsA = 0;
  let winsB = 0;
  let regressed = false;
  for (const t of tasks) {
    const [ra, rb] = [passRate(t.a), passRate(t.b)];
    if (rb > ra) winsB += 1;
    else if (ra > rb) winsA += 1;
    if (t.regressionSet && ra - rb > aaFlipRate) regressed = true;
  }
  const n = winsA + winsB;
  const p = signTestOneSided(n, winsB);
  const signTest = { n_discordant: n, wins_b: winsB, p };
  if (regressed || signTestOneSided(n, winsA) < LOOKBACK_LIMITS.signTestAlpha) {
    return { verdict: "regress", signTest };
  }
  if (p < LOOKBACK_LIMITS.signTestAlpha && tokensDeltaPct <= LOOKBACK_LIMITS.maxTokenRisePct) {
    return { verdict: "improve", signTest };
  }
  if (n === 0) return { verdict: "no_change", signTest };
  return { verdict: "inconclusive", signTest };
};

/** `.vtc/lookback/replays/<proposal>.json` (§13 step 3). */
export const ReplayResultSchema = z.strictObject({
  v: z.literal(1),
  proposal: SlugSchema,
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  host: HostIdSchema,
  baseline: Sha256HexSchema,
  candidate: Sha256HexSchema,
  grader_bundle_sha: Sha256HexSchema,
  k: z.int().min(1).max(10),
  per_task: z
    .array(
      z.strictObject({
        task: z.string().min(1).max(100),
        a: z.array(z.boolean()),
        b: z.array(z.boolean()),
        regression_set: z.boolean(),
      }),
    )
    .min(1),
  aa_flip_rate: z.number().min(0).max(1),
  sign_test: z.strictObject({
    n_discordant: z.int().nonnegative(),
    wins_b: z.int().nonnegative(),
    p: z.number().min(0).max(1),
  }),
  tokens_delta_pct: z.number(),
  verdict: ReplayVerdictSchema,
  finished_at: IsoDateTimeSchema,
});
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

// ------------------------------------------------------------------- canary

export interface CanaryArmStats {
  readonly dispatches: number;
  readonly escalations: number;
  readonly capHits: number;
  readonly tokens: number;
}

export const CanaryVerdictSchema = z.enum(["no_data", "continue", "rollback", "promotable"]);
export type CanaryVerdict = z.infer<typeof CanaryVerdictSchema>;

/**
 * Pure (§13 step 6, AD-21 rule 6): a human regression flag rolls back at once; otherwise, until
 * both arms have {@link LOOKBACK_LIMITS}`.minDispatchesPerArm` dispatches the state is `no_data`
 * (keep running, never promote); then escalations plus cap hits at twice the baseline rate or
 * more, or tokens per dispatch up more than 20%, roll back; after the canary window with no
 * trigger the candidate is `promotable` (a human approves).
 */
export const canaryVerdict = (
  candidate: CanaryArmStats,
  baseline: CanaryArmStats,
  humanRegressionFlag: boolean,
): { readonly verdict: CanaryVerdict; readonly reason: string } => {
  if (humanRegressionFlag) return { verdict: "rollback", reason: "a human flagged a regression" };
  const min = LOOKBACK_LIMITS.minDispatchesPerArm;
  if (candidate.dispatches < min || baseline.dispatches < min) {
    return { verdict: "no_data", reason: `fewer than ${String(min)} dispatches in an arm` };
  }
  const rate = (s: CanaryArmStats): number => (s.escalations + s.capHits) / s.dispatches;
  const [rc, rb] = [rate(candidate), rate(baseline)];
  if (rc > 0 && rc >= LOOKBACK_LIMITS.rollbackRateRatio * rb) {
    return { verdict: "rollback", reason: "escalations and cap hits at 2x the baseline or more" };
  }
  const perDispatch = (s: CanaryArmStats): number => s.tokens / s.dispatches;
  if (
    perDispatch(baseline) > 0 &&
    perDispatch(candidate) > perDispatch(baseline) * (1 + LOOKBACK_LIMITS.maxTokenRisePct / 100)
  ) {
    return { verdict: "rollback", reason: "tokens per dispatch up more than 20%" };
  }
  if (candidate.dispatches >= LOOKBACK_LIMITS.canaryWindow) {
    return { verdict: "promotable", reason: "canary window passed with no trigger" };
  }
  return { verdict: "continue", reason: "no trigger yet" };
};

const CanaryArmSchema = z.strictObject({
  dispatches: z.int().nonnegative(),
  escalations: z.int().nonnegative(),
  cap_hits: z.int().nonnegative(),
  tokens: z.int().nonnegative(),
});

/** A canary's state as the engine last computed it (Flow Studio, `lookback.canary_evaluated`). */
export const CanaryStateSchema = PinTargetSchema.extend({
  repo_key: RepoKeySchema,
  candidate: Sha256HexSchema,
  baseline: Sha256HexSchema,
  started_at: IsoDateTimeSchema,
  arms: z.strictObject({ candidate: CanaryArmSchema, baseline: CanaryArmSchema }),
  verdict: CanaryVerdictSchema,
  reason: z.string().min(1).max(300),
});
export type CanaryState = z.infer<typeof CanaryStateSchema>;

// -------------------------------------------------------------- attribution

/** The deterministic tree of §13 (credit goes to the first failure upstream). */
export const AttributionRuleSchema = z.enum([
  "missing_req",
  "req_without_test",
  "test_fails",
  "test_passes_behaviour_wrong",
]);
export type AttributionRule = z.infer<typeof AttributionRuleSchema>;

/** Which role the tree blames for each rule: BA, QA, Engineer, QA (Engineer secondary). */
export const ATTRIBUTION_TREE: Readonly<
  Record<AttributionRule, { readonly primary: string; readonly secondary: string | null }>
> = {
  missing_req: { primary: "ba", secondary: null },
  req_without_test: { primary: "qa", secondary: null },
  test_fails: { primary: "engineer", secondary: null },
  test_passes_behaviour_wrong: { primary: "qa", secondary: "engineer" },
};

/** One attributed trace (a dispatch joined with what happened downstream), one line each. */
export const AttributionSchema = z
  .strictObject({
    v: z.literal(1),
    /** The dispatch (`role.dispatched.action_id`). */
    trace: SlugSchema,
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    prompt: PromptVersionRefSchema,
    outcome: z.enum(["success", "failure"]),
    /** `null` for a success, or when even the tiebreak said "unknown". */
    blamed_role: RoleIdSchema.nullable(),
    secondary_role: RoleIdSchema.optional(),
    method: z.enum(["tree", "human", "ai_tiebreak"]),
    rule: AttributionRuleSchema.optional(),
    confidence: z.number().min(0).max(1),
    split: z.enum(["train", "holdout"]),
    evidence: z.array(EvidenceSchema).default([]),
    attributed_at: IsoDateTimeSchema,
  })
  .refine((a) => a.method !== "tree" || a.rule !== undefined, {
    message: "a tree attribution names its rule",
    path: ["rule"],
  });
export type Attribution = z.infer<typeof AttributionSchema>;

/**
 * One AI tiebreak answer the engine recorded ({@link LOOKBACK_HOME}`.tiebreaksFile`): the digest
 * that ties an `ai_tiebreak` {@link Attribution} row to it (the lookback module's `tiebreakKey`),
 * the run and dispatch it answered for, and the role it blamed (`null` = "unknown"). Only the
 * engine writes these; read with `parsePersisted`. New in 4.7.0 (spine §5 reading 137).
 */
export const LookbackTiebreakRecordSchema = z.strictObject({
  v: z.literal(1),
  tiebreak_key: Sha256HexSchema,
  repo_key: RepoKeySchema,
  run: RunIdSchema,
  /** The dispatch the answer is about (`role.dispatched.action_id`). */
  trace: SlugSchema,
  blamed_role: RoleIdSchema.nullable(),
  recorded_at: IsoDateTimeSchema,
});
export type LookbackTiebreakRecord = z.infer<typeof LookbackTiebreakRecordSchema>;

/**
 * Pure: the digest that ties an `ai_tiebreak` {@link Attribution} row to the engine's record of
 * that answer ({@link LookbackTiebreakRecord}`.tiebreak_key`): its run, trace, prompt version,
 * blame, confidence and evidence; `attributed_at` and `split` are left out, so neither can be
 * changed to re-key a row. Frozen in 4.10.0 (it was the lookback module's `tiebreakKey`, same
 * digest) so engine core can key a record it writes without importing lookback.
 */
export const lookbackTiebreakKey = (a: Attribution): string =>
  sha256Hex(
    JSON.stringify([
      a.run,
      a.trace,
      a.prompt.role,
      a.prompt.mode ?? null,
      a.prompt.host,
      a.prompt.effective_sha256,
      a.blamed_role,
      a.confidence,
      a.evidence.map((e) => [e.type, e.ref]),
    ]),
  );

/**
 * One measured A/A flip rate ({@link LOOKBACK_HOME}`.aaNoiseFile`, one JSON line per replay that
 * ran its own `aa` arm): the noise floor of a baseline under one grader bundle in one project.
 * Read with `parsePersisted`. New in 4.7.0 (it was the lookback module's own shape).
 */
export const AaNoiseRowSchema = z.strictObject({
  v: z.literal(1),
  repo_key: RepoKeySchema,
  role: RoleIdSchema,
  mode: SlugSchema.optional(),
  host: HostIdSchema,
  /** The baseline's `effective_sha256`. */
  baseline: Sha256HexSchema,
  grader_bundle_sha: Sha256HexSchema,
  aa_flip_rate: z.number().min(0).max(1),
  measured_at: IsoDateTimeSchema,
});
export type AaNoiseRow = z.infer<typeof AaNoiseRowSchema>;

// --------------------------------------------------------------- scorecards

/** Scorecard metrics (§13, round2 §5: outcome metrics plus quality per token). */
export const ScorecardMetricIdSchema = z.enum([
  "first_round_gate_pass",
  "review_pass",
  "rounds_to_done",
  "escalations_per_100",
  "cap_hits_per_100",
  "tokens_per_success",
]);
export type ScorecardMetricId = z.infer<typeof ScorecardMetricIdSchema>;

const MetricValueSchema = z.strictObject({
  /** `null` = insufficient data (n below `LOOKBACK_LIMITS.minScorecardN`). */
  value: z.number().nullable(),
  /** Wilson interval for proportions; `null` for counts and averages. */
  ci_low: z.number().nullable(),
  ci_high: z.number().nullable(),
  n: z.int().nonnegative(),
});

const MetricsSchema = z.partialRecord(ScorecardMetricIdSchema, MetricValueSchema);

/** `.vtc/lookback/scorecards/<role>/<host>/<sha8>/scorecard.json` (§13). */
export const ScorecardSchema = z.strictObject({
  v: z.literal(1),
  prompt: PromptVersionRefSchema,
  /** SHA of the grader bundle (graders, rubrics, metric code, judge model) that scored it. */
  grader_bundle_sha: Sha256HexSchema,
  window: z.strictObject({ from: IsoDateTimeSchema, to: IsoDateTimeSchema }),
  metrics: MetricsSchema,
  /** Engineer metrics by discipline × stack pack × host (§13). */
  breakdown: z
    .array(
      z.strictObject({
        discipline: DisciplineSchema.optional(),
        stack_pack: SlugSchema.optional(),
        host: HostIdSchema,
        metrics: MetricsSchema,
      }),
    )
    .default([]),
  written_at: IsoDateTimeSchema,
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

/** Pure: where a scorecard goes. */
export const scorecardPath = (role: string, host: string, effectiveSha: string): string =>
  `${LOOKBACK_REPO.scorecardsDir}/${RoleIdSchema.parse(role)}/${HostIdSchema.parse(host)}/${Sha256HexSchema.parse(effectiveSha).slice(0, 8)}/scorecard.json`;

/** `.vtc/lookback/scorecards/index.json`: what Flow Studio lists. */
export const ScorecardIndexSchema = z.strictObject({
  v: z.literal(1),
  scorecards: z.array(
    z.strictObject({
      prompt: PromptVersionRefSchema,
      path: RelPathSchema,
      written_at: IsoDateTimeSchema,
    }),
  ),
});
export type ScorecardIndex = z.infer<typeof ScorecardIndexSchema>;

// ---------------------------------------------------------------- proposals

/**
 * `.vtc/lookback/proposals/<role>/proposal.json`, next to the proposed `editable.md` (AD-14
 * rule 4). The engine rejects one that touches the locked core (`splitRolePrompt`), names an AD-9
 * marker (`findForbiddenInText`) or carries more than three changes.
 */
export const PromptProposalSchema = z.strictObject({
  v: z.literal(1),
  id: SlugSchema,
  base: PromptVersionRefSchema,
  changes: z
    .array(
      z.strictObject({
        hypothesis: z.string().min(1).max(1000),
        target_metric: ScorecardMetricIdSchema,
        trace_ids: z.array(SlugSchema).min(1).max(20),
        summary: z.string().min(1).max(500),
      }),
    )
    .min(1)
    .max(LOOKBACK_LIMITS.maxProposalChanges),
  /** The proposed editable section in full. */
  editable: z.string().min(1).max(20000),
  created_at: IsoDateTimeSchema,
});
export type PromptProposal = z.infer<typeof PromptProposalSchema>;

// ------------------------------------------------------------------- events

/** Payload of `lookback.escaped_defect`: a Level-3 merge was reverted or broke base CI (§6.7). */
export const EscapedDefectSchema = z.strictObject({
  merge_commit: GitShaSchema,
  kind: z.enum(["revert", "post_merge_ci_failure"]),
  tasks: z.array(TaskIdSchema).default([]),
});
export type EscapedDefect = z.infer<typeof EscapedDefectSchema>;
