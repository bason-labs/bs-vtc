/**
 * The replay trial ledger (D-cg; spine §5 reading 201; AD-21 rules 6 and 8). One RETRO launches at
 * most `LOOKBACK_LIMITS.maxTrialsPerRetro` trials (`planRetroReplays`), and a replay of k = 3
 * trials per task and arm needs more than that to reach the sign test's level, so the graded trials
 * of a replay are kept across RETROs here, and the next RETRO runs only the ones still missing.
 *
 * The ledger lives under the VTC home (`lookback/replay-trials.jsonl`, beside the A/A noise floors),
 * which no role may write (`ROLE_DENIED_VTC`: the VTC home's `lookback/**`), never in a repo: a
 * planted pass must not decide a replay. A row counts only for the replay it measured: the project
 * (`repo_key`), the proposal, its baseline and candidate (`effective_sha256`) and the grader bundle
 * it was graded under. The proposal id is a slug the lookback role chose, so the two prompt hashes
 * keep a later proposal that reuses an id from reading another candidate's grades, and a grader
 * change starts the replay over; a trial graded twice keeps its first grade. Lines that do not
 * parse are skipped. The row shape is local until a contract carries it (a contract proposal to
 * the integrator: `LOOKBACK_HOME.replayTrialsFile` and the row schema).
 *
 * A trial that measured nothing (`gate_infra`, or `plugin_locked`: the host did not prove it loaded
 * the arm's plugin) is not a grade. {@link recordReplayInfra} keeps it as an attempt, and
 * `planRetroReplays` stops launching a replay one of whose trials has failed that way
 * {@link REPLAY_MAX_INFRA_ATTEMPTS} times, so a persistent lock cannot spend every RETRO's trial cap.
 *
 * {@link assembleReplay} turns a complete set of rows into the `ReplayResult` (`finishReplay`), with
 * the A/A flip rate measured by the replay's own `aa` arm or the cached one, the candidate's token
 * change, the grader (reading 202) and the isolation every trial ran under (reading 178).
 */
import {
  IsoDateTimeSchema,
  RepoKeySchema,
  Sha256HexSchema,
  SlugSchema,
  type PromptVersionRef,
  type ReplayGrader,
  type ReplayResult,
} from "@vtc/shared";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonLines, readJsonLines } from "./files.js";
import { aaFlipRate, finishReplay, replayIsolation, tokensDeltaPct } from "./replay.js";

/** The ledger, relative to the VTC home (under `lookback/`, which roles may not write). */
export const REPLAY_TRIALS_FILE = "lookback/replay-trials.jsonl";

/** What identifies the replay a ledger row belongs to. */
const replayIdentity = {
  repo_key: RepoKeySchema,
  proposal: SlugSchema,
  /** The baseline's `effective_sha256`. */
  baseline: Sha256HexSchema,
  /** The candidate's `effective_sha256`. */
  candidate: Sha256HexSchema,
  /** The `ReplayResult.per_task` key (`replayTaskKey`). */
  task: z.string().min(1).max(100),
  arm: z.enum(["a", "b", "aa"]),
  trial: z.int().min(1).max(10),
  grader_bundle_sha: Sha256HexSchema,
};

const ReplayTrialRowSchema = z.strictObject({
  v: z.literal(1),
  ...replayIdentity,
  passed: z.boolean(),
  /** Input plus output tokens the trial used. */
  tokens: z.int().nonnegative(),
  /** The host enforced the repo's read deny on the trial (`SandboxProfile.enforced.readDeny`). */
  read_denied: z.boolean(),
  graded_at: IsoDateTimeSchema,
});
export type ReplayTrialRow = Omit<z.infer<typeof ReplayTrialRowSchema>, "v">;

/** Why a trial measured nothing (reading 201): no grade, an attempt. */
export type ReplayInfraOutcome = "gate_infra" | "plugin_locked";

const ReplayInfraRowSchema = z.strictObject({
  v: z.literal(1),
  ...replayIdentity,
  outcome: z.enum(["gate_infra", "plugin_locked"]),
  at: IsoDateTimeSchema,
});
export type ReplayInfraRow = Omit<z.infer<typeof ReplayInfraRowSchema>, "v">;

/** Attempts of one trial that measured nothing before its replay stops being launched. */
export const REPLAY_MAX_INFRA_ATTEMPTS = 3;

/** The replay a ledger read is for. */
export interface ReplayLedgerScope {
  readonly repoKey: string;
  readonly proposal: string;
  /** The baseline's `effective_sha256`. */
  readonly baseline: string;
  /** The candidate's `effective_sha256`. */
  readonly candidate: string;
  readonly graderBundleSha: string;
}

/** A trial as the plan, the ledger and the result key it. */
export interface ReplayTrialId {
  /**
   * The `ReplayResult.per_task` key (`replayTaskKey`: `<run>:<task>`, or for a verdict replay
   * `<run>:<subject>:<task>`).
   */
  readonly task: string;
  readonly arm: "a" | "b" | "aa";
  readonly trial: number;
}

/** Pure: a trial's key within its replay. */
export const replayTrialKey = (t: ReplayTrialId): string =>
  `${t.task}\n${t.arm}\n${String(t.trial)}`;

const ledgerPath = (vtcHome: string): string => join(vtcHome, REPLAY_TRIALS_FILE);

/** Records one graded trial (call it once the trial measured something: `pass` or `fail`). */
export const recordReplayTrial = async (vtcHome: string, row: ReplayTrialRow): Promise<void> => {
  await appendJsonLines(ledgerPath(vtcHome), [ReplayTrialRowSchema.parse({ v: 1, ...row })]);
};

/** Records one attempt of a trial that measured nothing (`gate_infra` or `plugin_locked`). */
export const recordReplayInfra = async (vtcHome: string, row: ReplayInfraRow): Promise<void> => {
  await appendJsonLines(ledgerPath(vtcHome), [ReplayInfraRowSchema.parse({ v: 1, ...row })]);
};

const inScope = (
  row: {
    readonly repo_key: string;
    readonly proposal: string;
    readonly baseline: string;
    readonly candidate: string;
    readonly grader_bundle_sha: string;
  },
  of: ReplayLedgerScope,
): boolean =>
  row.repo_key === of.repoKey &&
  row.proposal === of.proposal &&
  row.baseline === of.baseline &&
  row.candidate === of.candidate &&
  row.grader_bundle_sha === of.graderBundleSha;

/** The graded trials of one replay (project, proposal, baseline, candidate, grader bundle), by trial key. */
export const readReplayTrials = async (
  vtcHome: string,
  of: ReplayLedgerScope,
): Promise<Map<string, ReplayTrialRow>> => {
  const rows = new Map<string, ReplayTrialRow>();
  for (const value of await readJsonLines(ledgerPath(vtcHome))) {
    const parsed = ReplayTrialRowSchema.safeParse(value);
    if (!parsed.success) continue;
    const row = parsed.data;
    if (!inScope(row, of)) continue;
    const key = replayTrialKey(row);
    if (!rows.has(key)) rows.set(key, row);
  }
  return rows;
};

/** The attempts of one replay's trials that measured nothing, by trial key: how many, and the last outcome. */
export const readReplayInfra = async (
  vtcHome: string,
  of: ReplayLedgerScope,
): Promise<Map<string, { readonly attempts: number; readonly outcome: ReplayInfraOutcome }>> => {
  const attempts = new Map<string, { attempts: number; outcome: ReplayInfraOutcome }>();
  for (const value of await readJsonLines(ledgerPath(vtcHome))) {
    const parsed = ReplayInfraRowSchema.safeParse(value);
    if (!parsed.success || !inScope(parsed.data, of)) continue;
    const key = replayTrialKey(parsed.data);
    attempts.set(key, {
      attempts: (attempts.get(key)?.attempts ?? 0) + 1,
      outcome: parsed.data.outcome,
    });
  }
  return attempts;
};

/**
 * The replay's result once every planned trial has a row, or how many are still missing. A replay
 * that ran its own `aa` arm returns the flip rate it measured (`measuredAaFlipRate`, for
 * `recordAaFlipRate`); otherwise `cachedAaFlipRate` is its noise floor (0 when none). A plan with
 * no trial can never finish (`reason: "no_tasks"`): the baseline has no held-out task to replay,
 * which `planRetroReplays` reports as unreplayable. A trial planned twice counts once.
 */
export const assembleReplay = (input: {
  readonly proposal: string;
  readonly baseline: PromptVersionRef;
  readonly candidate: PromptVersionRef;
  readonly grader: ReplayGrader;
  /** Every trial of the replay's plan, with whether its task is in the regression set. */
  readonly planned: readonly (ReplayTrialId & { readonly regressionSet: boolean })[];
  readonly rows: ReadonlyMap<string, ReplayTrialRow>;
  readonly cachedAaFlipRate?: number;
  readonly graderBundleSha: string;
  readonly now: Date;
}):
  | { readonly complete: false; readonly missing: number; readonly reason?: "no_tasks" }
  | {
      readonly complete: true;
      readonly result: ReplayResult;
      readonly measuredAaFlipRate?: number;
    } => {
  if (input.planned.length === 0) return { complete: false, missing: 0, reason: "no_tasks" };
  const seen = new Set<string>();
  const planned = input.planned.filter((t) => {
    const key = replayTrialKey(t);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const missing = planned.filter((t) => !input.rows.has(replayTrialKey(t))).length;
  if (missing > 0) return { complete: false, missing };
  const tasks = new Map<
    string,
    { a: boolean[]; b: boolean[]; aa: boolean[]; regressionSet: boolean }
  >();
  const tokens: { a: number[]; b: number[] } = { a: [], b: [] };
  const readDenied: boolean[] = [];
  let k = 1;
  for (const t of planned) {
    const row = input.rows.get(replayTrialKey(t));
    if (row === undefined) continue;
    const entry = tasks.get(t.task) ?? { a: [], b: [], aa: [], regressionSet: t.regressionSet };
    entry[t.arm].push(row.passed);
    tasks.set(t.task, entry);
    if (t.arm !== "aa") tokens[t.arm].push(row.tokens);
    readDenied.push(row.read_denied);
    k = Math.max(k, t.trial);
  }
  const withAa = [...tasks.values()].filter((r) => r.aa.length > 0);
  const measured =
    withAa.length > 0 ? aaFlipRate(withAa.map((r) => ({ a: r.a, aa: r.aa }))) : undefined;
  const result = finishReplay({
    proposal: input.proposal,
    baseline: input.baseline,
    candidate: input.candidate,
    graderBundleSha: input.graderBundleSha,
    k,
    perTask: [...tasks].map(([task, r]) => ({
      task,
      a: r.a,
      b: r.b,
      regressionSet: r.regressionSet,
    })),
    aaFlipRate: measured ?? input.cachedAaFlipRate ?? 0,
    tokensDeltaPct: tokensDeltaPct(tokens.a, tokens.b),
    now: input.now,
    grader: input.grader,
    isolation: replayIsolation(readDenied),
  });
  return measured === undefined
    ? { complete: true, result }
    : { complete: true, result, measuredAaFlipRate: measured };
};
