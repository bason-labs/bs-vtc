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
 * A rise above the limit is a regression. Engine core raises the `cost` issue from it (the
 * upstream module, `costReportFields`) and RETRO queues the lookback role with a target aimed at
 * tokens (`lookbackTargets`), whose proposal is checked like any other (at most three changes,
 * editable section only); its changes aimed at tokens may cite the costliest train-split
 * dispatches the regression names.
 */
import {
  isEventOfType,
  LOOKBACK_LIMITS,
  type HostId,
  type PromptVersionRef,
  type Scorecard,
  type VtcEvent,
} from "@vtc/shared";
import {
  buildTraces,
  targetKey,
  traceSlug,
  traceSplit,
  type LockedShaFor,
  type Trace,
} from "./traces.js";

export type CostMetric = "tokens_per_success" | "cost_per_task";

/** A metric's value (`null`: insufficient data) and its n, or absent. */
type Measured = { readonly value: number | null; readonly n: number } | undefined;

export interface CostRegression {
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  readonly baseline: PromptVersionRef;
  readonly current: PromptVersionRef;
  readonly metric: CostMetric;
  readonly baseline_value: number;
  readonly current_value: number;
  /** The rise in percent of the baseline (two decimals). */
  readonly delta_pct: number;
  readonly n: { readonly baseline: number; readonly current: number };
  /** When the current version first ran (its scorecard window's start). */
  readonly since: string;
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

/** Mean reported cost per task of each version (`versionKey` → value and n). */
const costPerTask = (
  history: readonly VtcEvent[],
  traces: readonly Trace[],
): Map<string, NonNullable<Measured>> => {
  const cost = new Map<string, number | null>();
  for (const event of history) {
    if (!isEventOfType(event, "role.submitted")) continue;
    const priced = event.cost_usd;
    cost.set(
      `${event.run}:${(event.data as { action_id: string }).action_id}`,
      typeof priced === "number" ? priced : null,
    );
  }
  // version -> task -> summed cost (null once any dispatch of it reported none)
  const perTask = new Map<string, Map<string, number | null>>();
  for (const t of traces) {
    if (t.prompt === undefined || t.task === undefined || t.end?.kind !== "submitted") continue;
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

/** The cost regressions of every target's current version against its baseline version. */
export const costRegressions = (input: {
  readonly scorecards: readonly Scorecard[];
  readonly history: readonly VtcEvent[];
  readonly lockedShaFor: LockedShaFor;
}): CostRegression[] => {
  const byTarget = new Map<string, Scorecard[]>();
  for (const card of input.scorecards) {
    const key = targetKey(card.prompt);
    byTarget.set(key, [...(byTarget.get(key) ?? []), card]);
  }
  const traces = buildTraces(input.history, input.lockedShaFor);
  const costs = costPerTask(input.history, traces);
  const costliest = (version: PromptVersionRef): CostTrace[] =>
    traces
      .filter(
        (t) =>
          t.prompt !== undefined &&
          versionKey(t.prompt) === versionKey(version) &&
          t.end?.kind === "submitted" &&
          t.end.tokens !== null &&
          traceSplit(t) === "train",
      )
      .map((t) => ({ id: traceSlug(t), run: t.run, trace: t.trace, tokens: t.end?.tokens ?? 0 }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, COST_TRACES_MAX);
  const found: CostRegression[] = [];
  for (const cards of byTarget.values()) {
    const ordered = [...cards].sort((a, b) => a.window.to.localeCompare(b.window.to));
    const current = ordered.at(-1);
    const baseline = ordered.at(-2);
    if (current === undefined || baseline === undefined) continue;
    if (current.grader_bundle_sha !== baseline.grader_bundle_sha) continue;
    const costOf = (card: Scorecard) => costs.get(versionKey(card.prompt));
    const pairs: readonly (readonly [CostMetric, Measured, Measured])[] = [
      [
        "tokens_per_success",
        baseline.metrics.tokens_per_success,
        current.metrics.tokens_per_success,
      ],
      ["cost_per_task", costOf(baseline), costOf(current)],
    ];
    for (const [metric, before, after] of pairs) {
      const from = before?.value ?? null;
      const to = after?.value ?? null;
      if (from === null || to === null || from <= 0 || before === undefined || after === undefined)
        continue;
      const delta = ((to - from) / from) * 100;
      if (delta <= LOOKBACK_LIMITS.maxTokenRisePct) continue;
      const { prompt } = current;
      found.push({
        role: prompt.role,
        ...(prompt.mode === undefined ? {} : { mode: prompt.mode }),
        host: prompt.host,
        baseline: baseline.prompt,
        current: prompt,
        metric,
        baseline_value: from,
        current_value: to,
        delta_pct: round(delta, 2),
        n: { baseline: before.n, current: after.n },
        since: current.window.from,
        traces: costliest(prompt),
      });
    }
  }
  return found;
};
