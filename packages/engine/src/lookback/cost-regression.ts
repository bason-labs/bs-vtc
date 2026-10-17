/**
 * Cost regressions (D-bv; spine §5 reading 190; AD-21 rule 5): a role's quality per token or cost
 * per task worse than its scorecard baseline beyond `LOOKBACK_LIMITS.maxTokenRisePct`. Pure.
 *
 * For each prompt target (role, mode, host) the **current** version is the one whose scorecard
 * window ends last, and its **baseline** the version that ran before it (the scorecard whose
 * window ends next), scored under the same grader bundle (scores under other graders are never
 * compared, AD-21 rule 5). Two metrics are compared, each only when both versions have at least
 * `LOOKBACK_LIMITS.minScorecardN` data points:
 * - `tokens_per_success` (the scorecard's quality per token, inverted: tokens per successful
 *   dispatch);
 * - `cost_per_task`: the mean `cost_usd` the version's dispatches reported per task, over tasks
 *   where every dispatch of the version reported a cost.
 * A rise above the limit is a regression, marked `baseline_kind: previous_version`.
 *
 * **Drift baseline** (D-cr, spine §5 reading 226): the current version is also compared with its
 * own earlier window, so a model or host update that degrades an unchanged prompt is caught. Its
 * latest window is the `LOOKBACK_LIMITS.driftWindowDays` days up to its last dispatch, its baseline
 * the same number of days before that; each window counts the dispatches made in it (their outcomes
 * read from every later event), and both need `minScorecardN` data points per metric. The same two
 * cost metrics are compared (a quality drop with attributed failures shows as a rise in tokens per
 * success, since failures earn no success), and so is quality without attributed failures:
 * `escalations_per_100` and `cap_hits_per_100`, a regression when the latest window's rate is
 * above zero and at least `LOOKBACK_LIMITS.rollbackRateRatio` times the earlier one's: the shared
 * canary rule (`canaryVerdict`), so a healthy prompt that never escalated and starts escalating
 * after a model or host update is caught (a zero earlier rate counts; both windows still need
 * `minScorecardN` dispatches). Against a zero earlier rate a rise has no percentage: its
 * `delta_pct` is then the absolute rise of the rate (per 100). Each is marked
 * `baseline_kind: time_window` with both `windows`, and its baseline and current name the same
 * version. The cost metrics divide by their baseline, so a zero baseline is never compared.
 *
 * The `cost` issue is engine core's to raise (the upstream module, `costReportFields`):
 * `lookbackRunEndFacts` maps a drift regression to its automation fact for engine core's daemon
 * to hand over at the run's end (that call is a contract proposal to engine core, not yet wired),
 * and RETRO queues the
 * lookback role with a target aimed at tokens (`lookbackTargets`, a cost metric only), whose
 * proposal is checked like any other (at most three changes, editable section only); its changes
 * aimed at tokens may cite the costliest train-split dispatches the regression names.
 */
import {
  isEventOfType,
  LOOKBACK_LIMITS,
  type Attribution,
  type HostId,
  type PromptVersionRef,
  type Scorecard,
  type VtcEvent,
} from "@vtc/shared";
import { isRoleFailure } from "./attribution.js";
import {
  metricsOf,
  taskInfo,
  traceOutcomes,
  type TaskInfo,
  type TimeWindow,
  type TraceOutcome,
} from "./scorecards.js";
import {
  buildTraces,
  targetKey,
  traceRef,
  traceSlug,
  traceSplit,
  type LockedShaFor,
  type Trace,
} from "./traces.js";

/**
 * What regressed: the two cost metrics, and (drift baseline only) the two quality rates engine core
 * also watches for the version before.
 */
export type CostMetric =
  "tokens_per_success" | "cost_per_task" | "escalations_per_100" | "cap_hits_per_100";

/** The cost metrics: a regression in one of them aims a lookback target at tokens. */
export const isTokenMetric = (metric: CostMetric): boolean =>
  metric === "tokens_per_success" || metric === "cost_per_task";

/**
 * What a regression was measured against (D-cr): the version that ran before (`previous_version`)
 * or the same version's own window `LOOKBACK_LIMITS.driftWindowDays` days earlier (`time_window`).
 */
export type CostBaselineKind = "previous_version" | "time_window";

/** A metric's value (`null`: insufficient data) and its n, or absent. */
type Measured = { readonly value: number | null; readonly n: number } | undefined;

export interface CostRegression {
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  readonly baseline_kind: CostBaselineKind;
  /** The baseline version: for `time_window`, the current version itself. */
  readonly baseline: PromptVersionRef;
  readonly current: PromptVersionRef;
  readonly metric: CostMetric;
  readonly baseline_value: number;
  readonly current_value: number;
  /**
   * The rise in percent of the baseline (two decimals); always finite. From a zero baseline (a
   * quality rate only) it is the absolute rise of the rate, per 100.
   */
  readonly delta_pct: number;
  readonly n: { readonly baseline: number; readonly current: number };
  /**
   * When what regressed began: the current version's first dispatch (its scorecard window's
   * start), or for `time_window` the start of its latest window.
   */
  readonly since: string;
  /** `time_window` only: the two windows compared. */
  readonly windows?: { readonly baseline: TimeWindow; readonly current: TimeWindow };
  /**
   * The current version's costliest train-split dispatches that submitted (at most
   * {@link COST_TRACES_MAX}), most tokens first: what the lookback role reads and a change aimed
   * at tokens may cite (`checkProposal`). Never a held-out trace.
   */
  readonly traces: readonly CostTrace[];
}

/** A dispatch a cost-aimed proposal may cite: its slug (`traceSlug`), run, action and tokens. */
export interface CostTrace {
  readonly id: string;
  readonly run: string;
  readonly trace: string;
  readonly tokens: number;
}

/** Most dispatches a cost regression names (§13 step 1: 5–10 traces). */
export const COST_TRACES_MAX = 10;

const round = (value: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};

const versionKey = (p: PromptVersionRef): string => `${targetKey(p)}:${p.effective_sha256}`;

const inWindow = (ts: string, window: TimeWindow | undefined): boolean => {
  if (window === undefined) return true;
  const t = Date.parse(ts);
  return t > Date.parse(window.from) && t <= Date.parse(window.to);
};

/** Each submitted dispatch's reported cost (`null`: none), by `<run>:<action_id>`. */
const dispatchCosts = (history: readonly VtcEvent[]): Map<string, number | null> => {
  const cost = new Map<string, number | null>();
  for (const event of history) {
    if (!isEventOfType(event, "role.submitted")) continue;
    const priced = event.cost_usd;
    cost.set(
      `${event.run}:${(event.data as { action_id: string }).action_id}`,
      typeof priced === "number" ? priced : null,
    );
  }
  return cost;
};

/**
 * Mean reported cost per task of each version (`versionKey` → value and n), over the dispatches
 * made in `window` when one is given.
 */
const costPerTask = (
  cost: ReadonlyMap<string, number | null>,
  traces: readonly Trace[],
  window?: TimeWindow,
): Map<string, NonNullable<Measured>> => {
  // version -> task -> summed cost (null once any dispatch of it reported none)
  const perTask = new Map<string, Map<string, number | null>>();
  for (const t of traces) {
    if (t.prompt === undefined || t.task === undefined || t.end?.kind !== "submitted") continue;
    if (!inWindow(t.ts, window)) continue;
    const version = versionKey(t.prompt);
    const tasks = perTask.get(version) ?? new Map<string, number | null>();
    const key = `${t.run}:${t.task}`;
    const add = cost.get(`${t.run}:${t.trace}`) ?? null;
    const sum = tasks.has(key) ? (tasks.get(key) ?? null) : 0;
    tasks.set(key, sum === null || add === null ? null : sum + add);
    perTask.set(version, tasks);
  }
  const out = new Map<string, { value: number | null; n: number }>();
  for (const [version, tasks] of perTask) {
    const priced = [...tasks.values()].filter((v): v is number => v !== null);
    const n = priced.length;
    out.set(version, {
      value:
        n < LOOKBACK_LIMITS.minScorecardN ? null : round(priced.reduce((s, v) => s + v, 0) / n, 6),
      n,
    });
  }
  return out;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** The quality rates (drift only): compared by ratio, from a zero baseline too. */
const isRateMetric = (metric: CostMetric): boolean =>
  metric === "escalations_per_100" || metric === "cap_hits_per_100";

/**
 * Whether `metric` regressed from `from` to `to` (both known). A rate follows the shared canary
 * rule (`rc > 0 && rc >= rollbackRateRatio * rb`, a zero baseline included); a cost metric needs
 * a baseline above zero, since its rise is a percentage of it.
 */
const regressed = (metric: CostMetric, from: number, to: number): boolean =>
  isRateMetric(metric)
    ? to > 0 && to >= from * LOOKBACK_LIMITS.rollbackRateRatio
    : from > 0 && ((to - from) / from) * 100 > LOOKBACK_LIMITS.maxTokenRisePct;

/**
 * The cost regressions of every target's current version against its baseline version and
 * against its own earlier window (D-cr). `attributions` decide which dispatches failed in the drift
 * windows' tokens per success (the trusted rows the scorecards were computed with); without them a
 * submitted dispatch counts as a success.
 */
export const costRegressions = (input: {
  readonly scorecards: readonly Scorecard[];
  readonly history: readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
  readonly attributions?: readonly Attribution[];
}): CostRegression[] => {
  const byTarget = new Map<string, Scorecard[]>();
  for (const card of input.scorecards) {
    const key = targetKey(card.prompt);
    byTarget.set(key, [...(byTarget.get(key) ?? []), card]);
  }
  const traces = buildTraces(input.history, input.lockedShaFor);
  const cost = dispatchCosts(input.history);
  const costs = costPerTask(cost, traces);
  // the drift windows' outcomes, computed once for every target (lazily: only a target with an
  // earlier window needs them)
  let drift: { outcomes: TraceOutcome[]; tasks: Map<string, TaskInfo> } | undefined;
  const driftInputs = () => {
    if (drift === undefined) {
      const failed = new Set((input.attributions ?? []).filter(isRoleFailure).map(traceRef));
      drift = {
        outcomes: traceOutcomes(input.history, traces, failed),
        tasks: taskInfo(input.history),
      };
    }
    return drift;
  };
  const costliest = (version: PromptVersionRef, window?: TimeWindow): CostTrace[] =>
    traces
      .filter(
        (t) =>
          t.prompt !== undefined &&
          versionKey(t.prompt) === versionKey(version) &&
          t.end?.kind === "submitted" &&
          t.end.tokens !== null &&
          inWindow(t.ts, window) &&
          traceSplit(t) === "train",
      )
      .map((t) => ({ id: traceSlug(t), run: t.run, trace: t.trace, tokens: t.end?.tokens ?? 0 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, COST_TRACES_MAX);
  const found: CostRegression[] = [];
  const compare = (
    current: Scorecard,
    baseline: PromptVersionRef,
    pairs: readonly (readonly [CostMetric, Measured, Measured])[],
    windows?: { readonly baseline: TimeWindow; readonly current: TimeWindow },
  ): void => {
    for (const [metric, before, after] of pairs) {
      const from = before?.value ?? null;
      const to = after?.value ?? null;
      if (from === null || to === null || before === undefined || after === undefined) continue;
      if (!regressed(metric, from, to)) continue;
      const { prompt } = current;
      found.push({
        role: prompt.role,
        ...(prompt.mode === undefined ? {} : { mode: prompt.mode }),
        host: prompt.host,
        baseline_kind: windows === undefined ? "previous_version" : "time_window",
        baseline,
        current: prompt,
        metric,
        baseline_value: from,
        current_value: to,
        // a rise from zero has no percentage (only a rate gets here): the absolute rise instead
        delta_pct: round(from > 0 ? ((to - from) / from) * 100 : to - from, 2),
        n: { baseline: before.n, current: after.n },
        since: windows === undefined ? current.window.from : windows.current.from,
        ...(windows === undefined ? {} : { windows }),
        traces: costliest(prompt, windows?.current),
      });
    }
  };
  /** The version's scorecard metrics and cost per task over the dispatches made in `window`. */
  const windowed = (card: Scorecard, window: TimeWindow) => {
    const { outcomes, tasks } = driftInputs();
    const version = versionKey(card.prompt);
    const rows = outcomes.filter(
      (o) =>
        o.trace.prompt !== undefined &&
        versionKey(o.trace.prompt) === version &&
        inWindow(o.trace.ts, window),
    );
    return {
      metrics: metricsOf(rows, tasks),
      cost: costPerTask(cost, traces, window).get(version),
    };
  };
  for (const cards of byTarget.values()) {
    const ordered = [...cards].sort((a, b) => a.window.to.localeCompare(b.window.to));
    const current = ordered.at(-1);
    if (current === undefined) continue;
    const baseline = ordered.at(-2);
    if (baseline !== undefined && current.grader_bundle_sha === baseline.grader_bundle_sha) {
      const costOf = (card: Scorecard) => costs.get(versionKey(card.prompt));
      compare(current, baseline.prompt, [
        [
          "tokens_per_success",
          baseline.metrics.tokens_per_success,
          current.metrics.tokens_per_success,
        ],
        ["cost_per_task", costOf(baseline), costOf(current)],
      ]);
    }
    // D-cr: the same version, its latest window against the one before it
    const end = Date.parse(current.window.to);
    if (Number.isNaN(end)) continue;
    const span = LOOKBACK_LIMITS.driftWindowDays * DAY_MS;
    const iso = (ms: number): string => new Date(ms).toISOString();
    const windows = {
      baseline: { from: iso(end - 2 * span), to: iso(end - span) },
      current: { from: iso(end - span), to: current.window.to },
    };
    if (Date.parse(current.window.from) > end - span) continue;
    const before = windowed(current, windows.baseline);
    const after = windowed(current, windows.current);
    compare(
      current,
      current.prompt,
      [
        ["tokens_per_success", before.metrics.tokens_per_success, after.metrics.tokens_per_success],
        ["cost_per_task", before.cost, after.cost],
        [
          "escalations_per_100",
          before.metrics.escalations_per_100,
          after.metrics.escalations_per_100,
        ],
        ["cap_hits_per_100", before.metrics.cap_hits_per_100, after.metrics.cap_hits_per_100],
      ],
      windows,
    );
  }
  return found;
};
