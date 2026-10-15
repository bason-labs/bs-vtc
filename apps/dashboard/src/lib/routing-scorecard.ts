import {
  LOOKBACK_LIMITS,
  RoutingScorecardSchema,
  tierRank,
  type ArtifactContent,
  type RoutingScorecard,
  type TaskRiskClass,
} from "@vtc/shared";
import { readJsonArtifact, type Read } from "./read-json";
import { TIER_LABELS } from "./routing";
import {
  intervalRange,
  isInsufficient,
  proportionInterval,
  valueText,
  type MetricKind,
  type MetricValue,
} from "./scorecards";

/**
 * The routing scorecard (D-cn; spine §5 reading 219), `.vtc/lookback/scorecards/routing.json`:
 * for each (role, mode, host, size, risk class, start tier) cell, quality (pass rates with their
 * 95% interval), tokens per success, the share of tasks whose tier escalated and the cost per
 * task. Lookback reads a cell from `LOOKBACK_LIMITS.routingMinTasks` tasks; below the minimum n a
 * metric is "insufficient data", as on every scorecard. Routing PRs capture it as chart evidence.
 */
export const readRoutingScorecard = (artifact: ArtifactContent): Read<RoutingScorecard> =>
  readJsonArtifact(RoutingScorecardSchema, artifact);

type Cell = RoutingScorecard["cells"][number];

export const RISK_CLASS_LABELS: Readonly<Record<TaskRiskClass, string>> = {
  none: "no risk tag",
  tagged: "risk tag",
  high: "high risk",
};

const START_LABELS: Readonly<Record<Cell["start_reason"], string>> = {
  rule: "routing table",
  planner_hint: "Planner hint",
  role: "role's own tier",
};

const SIZE_ORDER: readonly Cell["size"][] = ["S", "M", "L"];
const RISK_ORDER: readonly TaskRiskClass[] = ["none", "tagged", "high"];
const START_ORDER: readonly Cell["start_reason"][] = ["rule", "planner_hint", "role"];

export interface RoutingMetric {
  readonly value: string;
  /** `40–81%` for a proportion with data, else `null`. */
  readonly interval: string | null;
  readonly n: number;
  readonly insufficient: boolean;
  /** Where a proportion and its interval sit on 0–1 (the chart's mark); `null` otherwise. */
  readonly mark: { readonly value: number; readonly low: number; readonly high: number } | null;
}

export interface RoutingCellView {
  /** `S-none-low-rule`: unique within its group. */
  readonly key: string;
  readonly size: Cell["size"];
  readonly risk: string;
  readonly tier: string;
  readonly start: string;
  readonly tasks: string;
  /** Whether Lookback reads the cell (at least `routingMinTasks` tasks). */
  readonly read: boolean;
  readonly gatePass: RoutingMetric | null;
  readonly reviewPass: RoutingMetric | null;
  readonly tokensPerSuccess: RoutingMetric | null;
  readonly escalated: RoutingMetric | null;
  readonly costPerTask: RoutingMetric | null;
}

export interface RoutingGroupView {
  readonly key: string;
  /** `engineer · claude-code`, `qa (author) · codex`. */
  readonly title: string;
  readonly cells: readonly RoutingCellView[];
}

export interface RoutingScorecardView {
  readonly grader: string;
  readonly window: RoutingScorecard["window"];
  readonly groups: readonly RoutingGroupView[];
}

const metric = (kind: MetricKind, m: MetricValue | undefined): RoutingMetric | null => {
  if (m === undefined) return null;
  const value = m.value;
  if (isInsufficient(m) || value === null) {
    // A cost with enough tasks but no value: the host reports no price (`cost_per_task_usd`).
    const unpriced = kind === "usd" && value === null && m.n >= LOOKBACK_LIMITS.minScorecardN;
    return {
      value: unpriced ? "unpriced" : "insufficient data",
      interval: null,
      n: m.n,
      insufficient: true,
      mark: null,
    };
  }
  if (kind !== "proportion")
    return {
      value: valueText(kind, value),
      interval: null,
      n: m.n,
      insufficient: false,
      mark: null,
    };
  const { low, high } = proportionInterval({ ...m, value });
  return {
    value: valueText(kind, value),
    interval: intervalRange({ ...m, value }),
    n: m.n,
    insufficient: false,
    mark: { value, low, high },
  };
};

const cellOrder = (a: Cell, b: Cell): number =>
  SIZE_ORDER.indexOf(a.size) - SIZE_ORDER.indexOf(b.size) ||
  RISK_ORDER.indexOf(a.risk) - RISK_ORDER.indexOf(b.risk) ||
  tierRank(a.start_tier) - tierRank(b.start_tier) ||
  START_ORDER.indexOf(a.start_reason) - START_ORDER.indexOf(b.start_reason);

const cellView = (c: Cell): RoutingCellView => ({
  key: `${c.size}-${c.risk}-${c.start_tier}-${c.start_reason}`,
  size: c.size,
  risk: RISK_CLASS_LABELS[c.risk],
  tier: TIER_LABELS[c.start_tier],
  start: START_LABELS[c.start_reason],
  tasks: `${c.tasks.toLocaleString("en-US")} ${c.tasks === 1 ? "task" : "tasks"}`,
  read: c.tasks >= LOOKBACK_LIMITS.routingMinTasks,
  gatePass: metric("proportion", c.metrics.first_round_gate_pass),
  reviewPass: metric("proportion", c.metrics.review_pass),
  tokensPerSuccess: metric("tokens", c.metrics.tokens_per_success),
  escalated: metric("proportion", c.escalated),
  costPerTask: metric("usd", c.cost_per_task_usd),
});

/** The scorecard grouped by role (and mode) and host, each group's cells in table order. */
export const routingScorecardView = (scorecard: RoutingScorecard): RoutingScorecardView => {
  const groups = new Map<string, { title: string; cells: Cell[] }>();
  for (const cell of scorecard.cells) {
    const role = cell.mode === undefined ? cell.role : `${cell.role} (${cell.mode})`;
    const key = `${role}|${cell.host}`;
    const group = groups.get(key) ?? { title: `${role} · ${cell.host}`, cells: [] };
    group.cells.push(cell);
    groups.set(key, group);
  }
  return {
    grader: scorecard.grader_bundle_sha.slice(0, 12),
    window: scorecard.window,
    groups: [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, g]) => ({
        key,
        title: g.title,
        cells: [...g.cells].sort(cellOrder).map(cellView),
      })),
  };
};
