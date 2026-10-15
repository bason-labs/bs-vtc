/**
 * Lookback at `run.finished` (spec §13 "Improvement loop"; AD-21 rule 8). Engine core calls
 * {@link lookbackAtRunEnd} once per finished run; it:
 * 1. attributes the run's failures and appends them to `.vtc/lookback/attributions.jsonl`
 *    (traces already there are skipped, so a re-run after a restart adds nothing);
 * 2. recomputes the scorecards of every version in the history (the events of every run the
 *    scorecards cover; required, so a card is never rewritten from one run) and rewrites the index;
 * 3. decides which (role, host) targets get the lookback role ({@link lookbackTargets}): at least
 *    `minTrainFailures` attributed train failures of the version that ran, at least one of them new
 *    in this run, or a cost regression of the current version against its baseline (D-bv,
 *    `costRegressions`; once per version, aimed at tokens); `minWeeklyRemainingPct` of the weekly
 *    window left and budget available;
 * 4. returns what engine core hands the upstream module (spine §5 readings 190 and 198): the cost
 *    regressions (against the version before and the version's own earlier window, D-cr), and,
 *    when the installed roles are given, the new-agent signals (`newAgentSignals`, D-cd);
 * 5. recomputes the routing scorecard (D-cn, `computeRoutingScorecard`), writes it at
 *    `LOOKBACK_REPO.routingScorecard` when it has a cell, and returns the routing proposals it backs
 *    (`routingProposals`, scorecard evidence only: tier replays need the RETRO's trial budget, so
 *    engine core calls `routingProposals` again there with what is left of it).
 * {@link lookbackRunEndFacts} maps what of steps 4 and 5 engine core does not raise itself to the
 * automation facts the daemon hands the upstream module (the AD-27 issue → PR path).
 * It returns the `lookback.dispatched` drafts and what each lookback dispatch reads: train traces
 * only, plus the human edits of the version under review (§13 step 1, {@link humanEdits}) with
 * their diffs when the caller injects a reader. Engine core queues the dispatches like any role
 * step (and redacts the pack as it does every pack).
 *
 * `attributions.jsonl` is git-tracked, so only the rows {@link readAttributions} trusts count: a row
 * of a run outside the history, of a dispatch the history does not show, or of a failure its
 * events do not show is ignored (`trustedAttributions`).
 */
import {
  DEFAULT_ROUTING_TABLE,
  engineRepoKey,
  ScorecardMetricIdSchema,
  isEventOfType,
  LOOKBACK_LIMITS,
  readEventData,
  type Attribution,
  type RoutingScorecard,
  type RoutingTable,
  type Scorecard,
  type VtcEvent,
} from "@vtc/shared";
import type { AutomationFact } from "../core/index.js";
import {
  appendAttributions,
  attributeRun,
  isTrainFailure,
  readAttributions,
  type FailureSignal,
} from "./attribution.js";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { costRegressions, isTokenMetric, type CostRegression } from "./cost-regression.js";
import { capDiff, humanEdits, LOOKBACK_MAX_HUMAN_EDITS, type HumanEdit } from "./human-edits.js";
import { newAgentSignals, type InstalledRole, type NewAgentSignal } from "./new-agent.js";
import {
  computeRoutingScorecard,
  routingProposals,
  writeRoutingScorecard,
  type RoutingProposals,
} from "./routing.js";
import { computeScorecards, writeScorecards } from "./scorecards.js";
import { readTiebreakKeys } from "./tiebreaks.js";
import { sameTarget, targetKey, traceRef, traceSlug, type LockedShaFor } from "./traces.js";

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
  /**
   * The train-split failure traces the lookback role reads (never held-out ones): `id` is the
   * run-qualified slug it cites in `trace_ids` ({@link traceSlug}).
   */
  readonly traces: readonly { readonly id: string; readonly run: string; readonly trace: string }[];
  /**
   * Train-split human edits of this version's work (the newest {@link LOOKBACK_MAX_HUMAN_EDITS}):
   * the file, what the role submitted and what the human froze, and the diff when one was read.
   */
  readonly human_edits: readonly LookbackHumanEdit[];
  /**
   * The base's cost regressions against the version before it (D-bv): the proposal is aimed at
   * tokens. Empty for a target of failures alone.
   */
  readonly cost: readonly CostRegression[];
}

export interface LookbackHumanEdit {
  readonly id: string;
  readonly run: string;
  readonly trace: string;
  readonly path: string;
  readonly role_sha256: string;
  readonly human_sha256: string;
  readonly gates: readonly string[];
  /** Capped at `HUMAN_EDIT_DIFF_MAX_CHARS`. */
  readonly diff?: string;
}

/** Reads the diff of one human edit (role version → frozen version), e.g. from git. */
export type HumanEditDiff = (edit: HumanEdit) => Promise<string | undefined>;

export type LookbackSkipReason = "weekly_window" | "budget";

/** A lookback dispatch the history shows (`lookback.dispatched`): its target and when. */
export interface LookbackDispatched {
  readonly role: string;
  readonly mode?: string;
  readonly host: string;
  readonly ts: string;
}

/** The `lookback.dispatched` events of the history. */
const lookbackDispatches = (history: readonly VtcEvent[]): LookbackDispatched[] =>
  history.flatMap((e) => {
    if (!isEventOfType(e, "lookback.dispatched")) return [];
    const data = readEventData(e);
    return [
      {
        role: data.target_role,
        ...(data.target_mode === undefined ? {} : { mode: data.target_mode }),
        host: data.target_host,
        ts: e.ts,
      },
    ];
  });

/** Which targets get the lookback role now (pure). */
export const lookbackTargets = (input: {
  readonly attributions: readonly Attribution[];
  /** `traceRef`s attributed in the run that just finished. */
  readonly fresh: ReadonlySet<string>;
  /** Percent of the weekly window left; `null` when unknown (then Lookback waits). */
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
  /** Human edits of the history ({@link humanEdits}); only train-split ones are shown. */
  readonly humanEdits?: readonly HumanEdit[];
  /**
   * Cost regressions of current versions (D-bv, `costRegressions`): each of a cost metric
   * (`isTokenMetric`) makes its version a target aimed at tokens, unless a lookback run was
   * dispatched for the target since that version first ran ({@link LookbackDispatched}).
   */
  readonly costRegressions?: readonly CostRegression[];
  readonly lookbackDispatched?: readonly LookbackDispatched[];
}): { readonly targets: LookbackTarget[]; readonly skipped?: LookbackSkipReason } => {
  const versionKey = (p: Attribution["prompt"]): string => `${targetKey(p)}:${p.effective_sha256}`;
  const candidates = new Map<string, Attribution[]>();
  for (const a of input.attributions) {
    if (!isTrainFailure(a) || a.prompt.role === LOOKBACK_ROLE) continue;
    const key = versionKey(a.prompt);
    const list = candidates.get(key);
    if (list === undefined) candidates.set(key, [a]);
    else list.push(a);
  }
  const costOf = new Map<string, CostRegression[]>();
  for (const r of input.costRegressions ?? []) {
    // a quality-rate drift (escalations, cap hits) is an upstream fact only, not a token target
    if (r.role === LOOKBACK_ROLE || !isTokenMetric(r.metric)) continue;
    const key = versionKey(r.current);
    costOf.set(key, [...(costOf.get(key) ?? []), r]);
  }
  const targetOf = (
    base: Attribution["prompt"],
    rows: readonly Attribution[],
    cost: readonly CostRegression[],
  ): LookbackTarget => ({
    role: base.role,
    ...(base.mode === undefined ? {} : { mode: base.mode }),
    host: base.host,
    base,
    train_failures: rows.length,
    traces: rows
      .slice(-LOOKBACK_MAX_TRACES)
      .map((a) => ({ id: traceSlug(a), run: a.run, trace: a.trace })),
    human_edits: (input.humanEdits ?? [])
      .filter(
        (e) =>
          e.split === "train" &&
          sameTarget(e.prompt, base) &&
          e.prompt.effective_sha256 === base.effective_sha256,
      )
      .slice(-LOOKBACK_MAX_HUMAN_EDITS)
      .map((e) => ({
        id: e.id,
        run: e.run,
        trace: e.trace,
        path: e.path,
        role_sha256: e.role_sha256,
        human_sha256: e.human_sha256,
        gates: [...e.gates],
      })),
    cost,
  });
  const targets: LookbackTarget[] = [];
  const chosen = new Set<string>();
  for (const [key, rows] of candidates) {
    const base = rows[0]?.prompt;
    if (base === undefined || rows.length < LOOKBACK_LIMITS.minTrainFailures) continue;
    if (!rows.some((a) => input.fresh.has(traceRef(a)))) continue;
    targets.push(targetOf(base, rows, costOf.get(key) ?? []));
    chosen.add(key);
  }
  for (const [key, cost] of costOf) {
    const first = cost[0];
    if (first === undefined || chosen.has(key)) continue;
    const base = first.current;
    const already = (input.lookbackDispatched ?? []).some(
      (d) => sameTarget(d, base) && d.ts >= first.since,
    );
    if (already) continue;
    targets.push(targetOf(base, candidates.get(key) ?? [], cost));
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

/** The targets with each human edit's diff read through `read`, capped. */
const withDiffs = async (
  targets: readonly LookbackTarget[],
  edits: readonly HumanEdit[],
  read: HumanEditDiff,
): Promise<LookbackTarget[]> => {
  const editKey = (e: Pick<HumanEdit, "run" | "trace" | "path" | "human_sha256">): string =>
    `${traceRef(e)}\n${e.path}\n${e.human_sha256}`;
  const byKey = new Map(edits.map((e) => [editKey(e), e]));
  const out: LookbackTarget[] = [];
  for (const target of targets) {
    const human_edits: LookbackHumanEdit[] = [];
    for (const shown of target.human_edits) {
      const edit = byKey.get(editKey(shown));
      let diff: string | undefined;
      try {
        diff = edit === undefined ? undefined : await read(edit);
      } catch {
        diff = undefined;
      }
      human_edits.push(
        diff === undefined || diff === "" ? shown : { ...shown, diff: capDiff(diff) },
      );
    }
    out.push({ ...target, human_edits });
  }
  return out;
};

export interface RunEndResult {
  readonly attributions: Attribution[];
  readonly inconclusive: FailureSignal[];
  readonly scorecards: Scorecard[];
  readonly targets: LookbackTarget[];
  readonly skipped?: LookbackSkipReason;
  readonly events: LookbackEventDraft[];
  /** Cost regressions of current versions (D-bv), for the upstream module's `cost` issue. */
  readonly costRegressions: CostRegression[];
  /** Missing specialists (D-cd), when the installed roles were given; else empty. */
  readonly newAgents: NewAgentSignal[];
  /** The routing scorecard of the history (D-cn); written only when it has a cell. */
  readonly routingScorecard: RoutingScorecard;
  /** The routing-table changes it backs, with their `config` facts (scorecard evidence only). */
  readonly routing: RoutingProposals;
}

export const lookbackAtRunEnd = async (input: {
  readonly projectRoot: string;
  /** The finished run's events. */
  readonly events: readonly VtcEvent[];
  /** Events of every run the scorecards cover, the finished run's included. */
  readonly history: readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
  readonly graderBundleSha: string;
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
  readonly now: Date;
  /**
   * Reads a human edit's diff (git lives outside this module). A failure or `undefined` leaves the
   * edit without a diff: the lookback role still sees which file the human changed.
   */
  readonly humanEditDiff?: HumanEditDiff;
  /**
   * `tiebreakKey`s of the AI tiebreaks the engine recorded where no role can write
   * (`AttributionHistory.tiebreaks`): without them no `ai_tiebreak` row counts. Absent, they are
   * read from the tiebreak store under `vtcHome` ({@link readTiebreakKeys}) when that is given.
   */
  readonly tiebreaks?: ReadonlySet<string>;
  /** The VTC home whose `LOOKBACK_HOME.tiebreaksFile` holds the recorded tiebreaks. */
  readonly vtcHome?: string;
  /** The roles this vtc carries (the plugin catalog); absent: no new-agent signals. */
  readonly roles?: readonly InstalledRole[];
  /** The routing table the run routed with; default `DEFAULT_ROUTING_TABLE`. */
  readonly routingTable?: RoutingTable;
}): Promise<RunEndResult> => {
  const tiebreaks =
    input.tiebreaks ??
    (input.vtcHome === undefined
      ? undefined
      : await readTiebreakKeys(input.vtcHome, engineRepoKey(input.projectRoot)));
  const recorded = await readAttributions(input.projectRoot, {
    history: input.history,
    lockedShaFor: input.lockedShaFor,
    ...(tiebreaks === undefined ? {} : { tiebreaks }),
  });
  const result = attributeRun({
    events: input.events,
    lockedShaFor: input.lockedShaFor,
    now: input.now,
    already: new Set(recorded.map(traceRef)),
  });
  await appendAttributions(input.projectRoot, result.attributions);
  const all = [...recorded, ...result.attributions];
  const scorecards = computeScorecards({
    events: input.history,
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
  const routingTable = input.routingTable ?? DEFAULT_ROUTING_TABLE;
  const routingScorecard = computeRoutingScorecard({
    history: input.history,
    attributions: all,
    graderBundleSha: input.graderBundleSha,
    now: input.now,
    table: routingTable,
  });
  if (routingScorecard.cells.length > 0)
    await writeRoutingScorecard(input.projectRoot, routingScorecard);
  const edits = humanEdits(input.history, input.lockedShaFor);
  const regressions = costRegressions({
    scorecards,
    history: input.history,
    lockedShaFor: input.lockedShaFor,
    attributions: all,
  });
  const chosen = lookbackTargets({
    attributions: current,
    fresh: new Set(result.attributions.map(traceRef)),
    weeklyRemainingPct: input.weeklyRemainingPct,
    budgetAvailable: input.budgetAvailable,
    humanEdits: edits,
    costRegressions: regressions,
    lookbackDispatched: lookbackDispatches(input.history),
  });
  const { skipped } = chosen;
  const targets =
    input.humanEditDiff === undefined
      ? chosen.targets
      : await withDiffs(chosen.targets, edits, input.humanEditDiff);
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
    costRegressions: regressions,
    newAgents:
      input.roles === undefined
        ? []
        : newAgentSignals({ attributions: all, history: input.history, roles: input.roles }),
    routingScorecard,
    routing: routingProposals(routingScorecard, routingTable),
  };
};

/**
 * What a drift regression's fact names as its baseline (D-cr): the version's own SHA with this
 * suffix. The upstream module's `cost` fingerprint is (role, metric, baseline SHA), so a drift of
 * version V never shares a fingerprint, and so an issue, with a later version W's regression
 * against V (baseline V); repeated drifts of V share one and dedupe.
 */
export const DRIFT_BASELINE_SUFFIX = "@time_window";

/**
 * Pure: the automation facts of a run's end that engine core does not raise itself, for the daemon
 * to hand the upstream module (AD-27 rule 8; spine §5 readings 219 and 226):
 * - each drift regression (`baseline_kind: time_window`, D-cr) as a `cost` fact whose
 *   `baselinePromptSha` is the version's SHA plus {@link DRIFT_BASELINE_SUFFIX} and `promptSha` the
 *   version's own. A regression against the version before is engine core's
 *   (`costRegressionFacts` from the scorecards), and `cost_per_task` is no scorecard metric the
 *   fact can carry, so neither is repeated here (`costReportFields` still reports both);
 * - each routing change (D-cn) as a `config` improvement with its subject and numbers.
 */
export const lookbackRunEndFacts = (
  run: string,
  result: Pick<RunEndResult, "costRegressions" | "routing">,
  at: string,
): AutomationFact[] => {
  const out: AutomationFact[] = [];
  for (const r of result.costRegressions) {
    if (r.baseline_kind !== "time_window") continue;
    const metric = ScorecardMetricIdSchema.safeParse(r.metric);
    if (!metric.success) continue;
    out.push({
      target: "upstream",
      kind: "cost",
      run,
      source: "lookback.drift",
      at,
      role: r.role,
      ...(r.mode === undefined ? {} : { mode: r.mode }),
      host: r.host,
      promptSha: r.current.effective_sha256,
      baselinePromptSha: `${r.baseline.effective_sha256}${DRIFT_BASELINE_SUFFIX}`,
      metric: metric.data,
      baseline: r.baseline_value,
      current: r.current_value,
      detail: `${r.role} on ${r.host}: ${r.metric} went from ${String(r.baseline_value)} to ${String(r.current_value)} against the same prompt version ${String(LOOKBACK_LIMITS.driftWindowDays)} days earlier`,
    });
  }
  for (const f of result.routing.facts) {
    out.push({
      target: "upstream",
      kind: f.kind,
      run,
      source: "lookback.routing",
      at: f.at,
      role: f.role,
      subject: f.subject,
      metrics: f.metrics,
      detail: `the routing scorecard backs a start-tier change for ${f.subject}`,
    });
  }
  return out;
};
