/**
 * The replay trial ledger (D-cg; spine §5 reading 201; AD-21 rules 6 and 8). One RETRO launches at
 * most `LOOKBACK_LIMITS.maxTrialsPerRetro` trials (`planRetroReplays`), and a replay of k = 3
 * trials per task and arm needs more than that to reach the sign test's level, so the graded trials
 * of a replay are kept across RETROs here, and the next RETRO runs only the ones still missing.
 *
 * The ledger lives under the VTC home (`lookback/replay-trials.jsonl`, beside the A/A noise floors),
 * which no role may write (`ROLE_DENIED_VTC`: the VTC home's `lookback/**`), never in a repo: a
 * planted pass must not decide a replay. A row counts only for the project (`repo_key`), proposal
 * and grader bundle it was graded under, so a grader change starts the replay over; a trial graded
 * twice keeps its first grade. Lines that do not parse are skipped. The row shape is local until a
 * contract carries it (a contract proposal to the integrator).
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

const ReplayTrialRowSchema = z.strictObject({
  v: z.literal(1),
  repo_key: RepoKeySchema,
  proposal: SlugSchema,
  /** The `ReplayResult.per_task` key, `<run>:<task>`. */
  task: z.string().min(1).max(100),
  arm: z.enum(["a", "b", "aa"]),
  trial: z.int().min(1).max(10),
  passed: z.boolean(),
  /** Input plus output tokens the trial used. */
  tokens: z.int().nonnegative(),
  /** The host enforced the repo's read deny on the trial (`SandboxProfile.enforced.readDeny`). */
  read_denied: z.boolean(),
  grader_bundle_sha: Sha256HexSchema,
  graded_at: IsoDateTimeSchema,
});
export type ReplayTrialRow = Omit<z.infer<typeof ReplayTrialRowSchema>, "v">;

/** A trial as the plan, the ledger and the result key it. */
export interface ReplayTrialId {
  /** `<run>:<task>`. */
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

/** The graded trials of one replay in one project under one grader bundle, by trial key. */
export const readReplayTrials = async (
  vtcHome: string,
  of: { readonly repoKey: string; readonly proposal: string; readonly graderBundleSha: string },
): Promise<Map<string, ReplayTrialRow>> => {
  const rows = new Map<string, ReplayTrialRow>();
  for (const value of await readJsonLines(ledgerPath(vtcHome))) {
    const parsed = ReplayTrialRowSchema.safeParse(value);
    if (!parsed.success) continue;
    const row = parsed.data;
    if (
      row.repo_key !== of.repoKey ||
      row.proposal !== of.proposal ||
      row.grader_bundle_sha !== of.graderBundleSha
    )
      continue;
    const key = replayTrialKey(row);
    if (!rows.has(key)) rows.set(key, row);
  }
  return rows;
};

/**
 * The replay's result once every planned trial has a row, or how many are still missing. A replay
 * that ran its own `aa` arm returns the flip rate it measured (`measuredAaFlipRate`, for
 * `recordAaFlipRate`); otherwise `cachedAaFlipRate` is its noise floor (0 when none).
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
  | { readonly complete: false; readonly missing: number }
  | {
      readonly complete: true;
      readonly result: ReplayResult;
      readonly measuredAaFlipRate?: number;
    } => {
  const missing = input.planned.filter((t) => !input.rows.has(replayTrialKey(t))).length;
  if (missing > 0 || input.planned.length === 0)
    return { complete: false, missing: Math.max(missing, 1) };
  const tasks = new Map<
    string,
    { a: boolean[]; b: boolean[]; aa: boolean[]; regressionSet: boolean }
  >();
  const tokens: { a: number[]; b: number[] } = { a: [], b: [] };
  const readDenied: boolean[] = [];
  let k = 1;
  for (const t of input.planned) {
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
