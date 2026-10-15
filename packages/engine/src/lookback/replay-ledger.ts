/**
 * The replay trial ledger (D-cg; spine §5 reading 201; AD-21 rules 6 and 8). One RETRO launches at
 * most `LOOKBACK_LIMITS.maxTrialsPerRetro` trials (`planRetroReplays`), and a replay of k = 3
 * trials per task and arm needs more than that to reach the sign test's level, so the graded trials
 * of a replay are kept across RETROs here, and the next RETRO runs only the ones still missing.
 *
 * The ledger lives under the VTC home (`lookback/replay-trials.jsonl`, beside the A/A noise floors),
 * which no role may write (`ROLE_DENIED_VTC`: the VTC home's `lookback/**`), never in a repo: a
 * planted pass must not decide a replay. It is created owner-only (0600). A row counts only for
 * the replay it measured: the project (`repo_key`), the proposal, its baseline and candidate
 * (`effective_sha256`) and the grader bundle it was graded under. The proposal id is a slug the
 * lookback role chose, so the two prompt hashes keep a later proposal that reuses an id from
 * reading another candidate's grades, and a grader change starts the replay over; a trial graded
 * twice keeps its first grade. A verdict replay's task key carries the expected verdict
 * (`replayTaskKey`), so a row graded against an expectation the history has since overturned is
 * no longer planned and no longer counts. Lines that do not parse are skipped; a row with fields
 * this version does not know is read without them (`parsePersisted`), so an older vtc on the
 * machine never drops a newer one's grades and runs those trials again.
 *
 * **Contract.** The file name and the row shapes are contracts 5.1.0's
 * `LOOKBACK_HOME.replayTrialsFile`, `ReplayTrialRowSchema` and `ReplayInfraRowSchema` (AD-3).
 *
 * **Not wired yet.** Engine core's `LookbackRetro` seam cannot drive the ledger as it stands:
 * `replays()` hands back whole replays and core applies its own all-or-nothing trial cap,
 * `gradeTrial` carries no trial identity, an unmeasured trial is set aside by core and never
 * reported here, and `finishReplay` expects every outcome from one RETRO. Until core adopts
 * `planRetroReplays` and a per-trial outcome hook (the contract proposal to engine core and the
 * daemon owner: `replays()` returns `planRetroReplays().launch`, each graded or unmeasured trial
 * calls {@link recordReplayTrial} or {@link recordReplayInfra} with its ref, tokens and read deny,
 * `finishReplay` calls {@link assembleReplay} and logs nothing while it is incomplete), this module
 * and `planRetroReplays` are a library no RETRO calls, and core's own cap decides.
 *
 * A trial that measured nothing (`gate_infra`; `plugin_locked`: the host did not prove it loaded
 * the arm's plugin; `no_outcome`: a verdict trial whose replayed dispatch no longer has a recorded
 * outcome) is not a grade. {@link recordReplayInfra} keeps it as an attempt, and
 * `planRetroReplays` stops launching a replay one of whose trials has failed that way
 * {@link REPLAY_MAX_INFRA_ATTEMPTS} times, so a persistent failure cannot spend every RETRO's
 * trial cap.
 *
 * Reading: {@link readReplayLedger} parses the file once and indexes it by replay, so a RETRO that
 * plans several replays reads it once. The ledger is append-only and is not compacted yet: a
 * rewrite would race the appends of other daemons on the machine without a lock every writer
 * takes, which the contract above is the place to add.
 *
 * {@link assembleReplay} turns a complete set of rows into the `ReplayResult` (`finishReplay`), with
 * the A/A flip rate measured by the replay's own `aa` arm or the cached one, the candidate's token
 * change, the grader (reading 202) and the isolation every trial ran under (reading 178).
 */
import {
  LOOKBACK_HOME,
  parsePersisted,
  ReplayInfraOutcomeSchema,
  ReplayInfraRowSchema,
  ReplayTrialRowSchema,
  type PromptVersionRef,
  type ReplayGrader,
  type ReplayInfraOutcome,
  type ReplayInfraRow as SharedReplayInfraRow,
  type ReplayResult,
  type ReplayTrialRow as SharedReplayTrialRow,
} from "@vtc/shared";
import { join } from "node:path";
import { appendJsonLines, readJsonLines } from "./files.js";
import { aaFlipRate, finishReplay, replayIsolation, tokensDeltaPct } from "./replay.js";

/** The ledger, relative to the VTC home (under `lookback/`, which roles may not write). */
export const REPLAY_TRIALS_FILE = LOOKBACK_HOME.replayTrialsFile;

/** A graded trial as the ledger stores it, without the row version. */
export type ReplayTrialRow = Omit<SharedReplayTrialRow, "v">;

/** Why a trial measured nothing (reading 201): no grade, an attempt. */
export const REPLAY_INFRA_OUTCOMES = ReplayInfraOutcomeSchema.options;
export type { ReplayInfraOutcome };

/** A trial that measured nothing as the ledger stores it, without the row version. */
export type ReplayInfraRow = Omit<SharedReplayInfraRow, "v">;

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
   * `<run>:<subject>:<verdict>:<task>`).
   */
  readonly task: string;
  readonly arm: "a" | "b" | "aa";
  readonly trial: number;
}

/** Pure: a trial's key within its replay. */
export const replayTrialKey = (t: ReplayTrialId): string =>
  `${t.task}\n${t.arm}\n${String(t.trial)}`;

const ledgerPath = (vtcHome: string): string => join(vtcHome, REPLAY_TRIALS_FILE);

/** Owner-only, as the VTC home's other private files. */
const LEDGER_MODE = 0o600;

/** Records one graded trial (call it once the trial measured something: `pass` or `fail`). */
export const recordReplayTrial = async (vtcHome: string, row: ReplayTrialRow): Promise<void> => {
  await appendJsonLines(ledgerPath(vtcHome), [ReplayTrialRowSchema.parse({ v: 1, ...row })], {
    mode: LEDGER_MODE,
  });
};

/** Records one attempt of a trial that measured nothing (`gate_infra`, `plugin_locked`, `no_outcome`). */
export const recordReplayInfra = async (vtcHome: string, row: ReplayInfraRow): Promise<void> => {
  await appendJsonLines(ledgerPath(vtcHome), [ReplayInfraRowSchema.parse({ v: 1, ...row })], {
    mode: LEDGER_MODE,
  });
};

const scopeKey = (row: {
  readonly repo_key: string;
  readonly proposal: string;
  readonly baseline: string;
  readonly candidate: string;
  readonly grader_bundle_sha: string;
}): string =>
  [row.repo_key, row.proposal, row.baseline, row.candidate, row.grader_bundle_sha].join("\n");

const keyOfScope = (of: ReplayLedgerScope): string =>
  scopeKey({
    repo_key: of.repoKey,
    proposal: of.proposal,
    baseline: of.baseline,
    candidate: of.candidate,
    grader_bundle_sha: of.graderBundleSha,
  });

/** A trial's attempts that measured nothing: how many, and the last outcome. */
export interface ReplayInfraAttempts {
  readonly attempts: number;
  readonly outcome: ReplayInfraOutcome;
}

/** The ledger read once, indexed by replay. */
export interface ReplayLedger {
  /** The graded trials of one replay, by trial key (a trial graded twice keeps its first grade). */
  trials(of: ReplayLedgerScope): ReadonlyMap<string, ReplayTrialRow>;
  /** The attempts of one replay's trials that measured nothing, by trial key. */
  infra(of: ReplayLedgerScope): ReadonlyMap<string, ReplayInfraAttempts>;
}

const withoutVersion = <T extends { v: 1 }>(row: T): Omit<T, "v"> => {
  const rest: Partial<T> = { ...row };
  delete rest.v;
  return rest as Omit<T, "v">;
};

/** Reads the whole ledger once (see the module comment), for every replay a RETRO plans. */
export const readReplayLedger = async (vtcHome: string): Promise<ReplayLedger> => {
  const trials = new Map<string, Map<string, ReplayTrialRow>>();
  const infra = new Map<string, Map<string, { attempts: number; outcome: ReplayInfraOutcome }>>();
  for (const value of await readJsonLines(ledgerPath(vtcHome))) {
    const graded = parsePersisted(ReplayTrialRowSchema, value);
    if (graded.success) {
      const row = withoutVersion(graded.data);
      const scope = scopeKey(row);
      const rows = trials.get(scope) ?? new Map<string, ReplayTrialRow>();
      const key = replayTrialKey(row);
      if (!rows.has(key)) rows.set(key, row);
      trials.set(scope, rows);
      continue;
    }
    const attempt = parsePersisted(ReplayInfraRowSchema, value);
    if (!attempt.success) continue;
    const scope = scopeKey(attempt.data);
    const rows =
      infra.get(scope) ?? new Map<string, { attempts: number; outcome: ReplayInfraOutcome }>();
    const key = replayTrialKey(attempt.data);
    rows.set(key, { attempts: (rows.get(key)?.attempts ?? 0) + 1, outcome: attempt.data.outcome });
    infra.set(scope, rows);
  }
  return {
    trials: (of) => trials.get(keyOfScope(of)) ?? new Map(),
    infra: (of) => infra.get(keyOfScope(of)) ?? new Map(),
  };
};

/** The graded trials of one replay (project, proposal, baseline, candidate, grader bundle), by trial key. */
export const readReplayTrials = async (
  vtcHome: string,
  of: ReplayLedgerScope,
): Promise<ReadonlyMap<string, ReplayTrialRow>> => (await readReplayLedger(vtcHome)).trials(of);

/** The attempts of one replay's trials that measured nothing, by trial key: how many, and the last outcome. */
export const readReplayInfra = async (
  vtcHome: string,
  of: ReplayLedgerScope,
): Promise<ReadonlyMap<string, ReplayInfraAttempts>> => (await readReplayLedger(vtcHome)).infra(of);

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
