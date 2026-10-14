/**
 * Lookback at `run.finished` (spec §13 "Improvement loop"; AD-21 rule 8). Engine core calls
 * {@link lookbackAtRunEnd} once per finished run; it:
 * 1. attributes the run's failures and appends them to `.vtc/lookback/attributions.jsonl`
 *    (traces already there are skipped, so a re-run after a restart adds nothing);
 * 2. recomputes the scorecards of every version in the given history and rewrites the index;
 * 3. decides which (role, host) targets get the lookback role ({@link lookbackTargets}): at least
 *    `minTrainFailures` attributed train failures of the version that ran, at least one of them new
 *    in this run, `minWeeklyRemainingPct` of the weekly window left and budget available.
 * It returns the `lookback.dispatched` drafts and what each lookback dispatch reads (train traces
 * only); engine core queues the dispatches like any role step.
 */
import { LOOKBACK_LIMITS, type Attribution, type Scorecard, type VtcEvent } from "@vtc/shared";
import {
  appendAttributions,
  attributeRun,
  readAttributions,
  type FailureSignal,
} from "./attribution.js";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { computeScorecards, writeScorecards } from "./scorecards.js";
import { targetKey, traceRef, type LockedShaFor } from "./traces.js";

/** Most failures one lookback dispatch reads (§13 step 1: 5–10). */
export const LOOKBACK_MAX_TRACES = 10;

/** The role Lookback never dispatches itself for. */
const LOOKBACK_ROLE = "lookback";

export interface LookbackTarget {
  readonly role: string;
  readonly mode?: string;
  readonly host: Attribution["prompt"]["host"];
  /** The version the failures ran with (the proposal's base). */
  readonly base: Attribution["prompt"];
  readonly train_failures: number;
  /** The train-split failure traces the lookback role reads (never held-out ones). */
  readonly traces: readonly string[];
}

export type LookbackSkipReason = "weekly_window" | "budget";

/** Which targets get the lookback role now (pure). */
export const lookbackTargets = (input: {
  readonly attributions: readonly Attribution[];
  /** `traceRef`s attributed in the run that just finished. */
  readonly fresh: ReadonlySet<string>;
  /** Percent of the weekly window left; `null` when unknown (then Lookback waits). */
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
}): { readonly targets: LookbackTarget[]; readonly skipped?: LookbackSkipReason } => {
  const candidates = new Map<string, Attribution[]>();
  for (const a of input.attributions) {
    if (a.outcome !== "failure" || a.split !== "train" || a.prompt.role === LOOKBACK_ROLE) continue;
    const key = `${targetKey(a.prompt)}:${a.prompt.effective_sha256}`;
    candidates.set(key, [...(candidates.get(key) ?? []), a]);
  }
  const targets: LookbackTarget[] = [];
  for (const rows of candidates.values()) {
    const base = rows[0]?.prompt;
    if (base === undefined || rows.length < LOOKBACK_LIMITS.minTrainFailures) continue;
    if (!rows.some((a) => input.fresh.has(traceRef(a)))) continue;
    targets.push({
      role: base.role,
      ...(base.mode === undefined ? {} : { mode: base.mode }),
      host: base.host,
      base,
      train_failures: rows.length,
      traces: rows.slice(-LOOKBACK_MAX_TRACES).map((a) => a.trace),
    });
  }
  if (targets.length === 0) return { targets };
  if (
    input.weeklyRemainingPct === null ||
    input.weeklyRemainingPct < LOOKBACK_LIMITS.minWeeklyRemainingPct
  ) {
    return { targets: [], skipped: "weekly_window" };
  }
  if (!input.budgetAvailable) return { targets: [], skipped: "budget" };
  return { targets };
};

export interface RunEndResult {
  readonly attributions: Attribution[];
  readonly inconclusive: FailureSignal[];
  readonly scorecards: Scorecard[];
  readonly targets: LookbackTarget[];
  readonly skipped?: LookbackSkipReason;
  readonly events: LookbackEventDraft[];
}

export const lookbackAtRunEnd = async (input: {
  readonly projectRoot: string;
  /** The finished run's events. */
  readonly events: readonly VtcEvent[];
  /** Events of every run the scorecards cover (defaults to this run's). */
  readonly history?: readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
  readonly graderBundleSha: string;
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
  readonly now: Date;
}): Promise<RunEndResult> => {
  const recorded = await readAttributions(input.projectRoot);
  const result = attributeRun({
    events: input.events,
    lockedShaFor: input.lockedShaFor,
    now: input.now,
    already: new Set(recorded.map(traceRef)),
  });
  await appendAttributions(input.projectRoot, result.attributions);
  const all = [...recorded, ...result.attributions];
  const scorecards = computeScorecards({
    events: input.history ?? input.events,
    attributions: all,
    lockedShaFor: input.lockedShaFor,
    graderBundleSha: input.graderBundleSha,
    now: input.now,
  });
  if (scorecards.length > 0) await writeScorecards(input.projectRoot, scorecards);
  // Only the newest version of each target that this history ran is a proposal base.
  const latest = new Map<string, string>();
  for (const card of [...scorecards].sort((a, b) => a.window.to.localeCompare(b.window.to))) {
    latest.set(targetKey(card.prompt), card.prompt.effective_sha256);
  }
  const current = all.filter((a) => {
    const newest = latest.get(targetKey(a.prompt));
    return newest === undefined || newest === a.prompt.effective_sha256;
  });
  const { targets, skipped } = lookbackTargets({
    attributions: current,
    fresh: new Set(result.attributions.map(traceRef)),
    weeklyRemainingPct: input.weeklyRemainingPct,
    budgetAvailable: input.budgetAvailable,
  });
  const events = targets.map((t) =>
    lookbackEvent("lookback.dispatched", {
      target_role: t.role,
      ...(t.mode === undefined ? {} : { target_mode: t.mode }),
      target_host: t.host,
      train_failures: t.train_failures,
    }),
  );
  return {
    attributions: result.attributions,
    inconclusive: result.inconclusive,
    scorecards,
    targets,
    ...(skipped === undefined ? {} : { skipped }),
    events,
  };
};
