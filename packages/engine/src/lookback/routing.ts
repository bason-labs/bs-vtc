/**
 * Lookback tunes routing (D-cn; spine §5 readings 219, 241, 242 and 247(6); H-9, D-cm, D-cu, D-cv).
 * Pure, except {@link writeRoutingScorecard}.
 *
 * **The routing scorecard** ({@link computeRoutingScorecard}, `RoutingScorecard` at
 * `LOOKBACK_REPO.routingScorecard`): for each task, the first dispatch of each (role, mode) names a
 * cell (role, mode, host, size, risk class, start tier, start reason) from its
 * `role.dispatched.tier` / `tier_reason` and the task's Planner size and risk
 * (`taskRiskClass` under the routing table). The cell's metrics are the scorecard metrics
 * (`metricsOf`) over every dispatch of that (role, mode) on its tasks, so what a start tier cost
 * includes the rounds and escalations it led to. `escalated` is the share of the cell's tasks the
 * role escalated on (Wilson interval) by the shared rule (D-cv, `escalationSteps`): a task counts
 * when the role ran on it in a fix round in which the rule moves its start tier up (a Low start from
 * round 2, a Mid start from round 3; a Top start has no tier above it; the round is the task's
 * `task.status_changed` round at the dispatch), or when a dispatch of it was logged as an
 * `escalation`. So a log written before
 * D-cv, whose Low start ran its second round on Low, measures what the rule does now.
 * `cost_per_task_usd` is the mean cost the role's submitted dispatches reported per task, over
 * tasks where every one reported a cost. A dispatch logged before contracts 5.4.0 has no tier and is
 * skipped; a `lookback_replay` trial is no work of the run and is left out (reading 177); a first
 * dispatch whose reason is `escalation` or `budget_drop` names no start tier and is skipped, and so
 * is one the project's `routing.min_tier` / `max_tier` moved (`tier_clamped`): it measures the
 * project's bound, not the table. QA author's clamp to its floor is kept, since every QA author
 * start is floored ({@link routingProposals} compares against the floored tier). Below
 * `LOOKBACK_LIMITS.minScorecardN` a value is `null` ("insufficient data"), as on every scorecard;
 * the card records the grader bundle it was scored under. Reviewer cells stay on the card as
 * information: since D-cu a reviewer starts on its own `role.yaml` tier, which the table does not
 * set.
 *
 * **Proposals** ({@link routingProposals}): only the producers' cells (`routedByDifficulty`: the
 * Engineer family and QA author, D-cu) are read; a reviewer's cell neither proposes, backs nor
 * blocks a change. A cell is read from `LOOKBACK_LIMITS.routingMinTasks` tasks. For each (role,
 * mode, host, size, risk) group whose current start tier (the table's, {@link routedStartTier}) has
 * a readable cell:
 * - _higher_: at least `routingEscalationPct` percent of its tasks escalated, so the start moves
 *   one tier up (a change that would move the table's cell by two tiers, as QA author's floored
 *   start does on a cell the table starts on Low, is dropped);
 * - _cheaper_: a cheaper start tier's readable cell has every pass rate the current cell measures
 *   (`first_round_gate_pass`, `review_pass`) within `routingQualityMarginPct` points and does not
 *   keep escalating itself; the cheapest such tier is proposed. Only a `rule` or `role` cell (a
 *   `routing.start: role` project starts every task on the role's tier) is such evidence: a
 *   `planner_hint` cell holds the tasks the Planner judged unlike their size and tags (reading
 *   218(3)), a biased sample of the (size, risk) cell. QA in author mode is never proposed
 *   below `QA_AUTHOR_MIN_TIER` (spec §5.2).
 * The groups of one (role, size, risk) cell of the table agree, or nothing changes: any _higher_
 * wins (safety first), and a group that compared a cheaper tier and found it worse blocks a
 * _cheaper_ one. A change backed by two or more roles that no other role contradicts changes the
 * shared table; otherwise it goes under `roles.<role>` (D-cn: "one role's cells under `roles` when
 * only that role differs"). The table's floors are floors (a tagged start is the higher of
 * `by_size` and `tagged_floor`), so raising a start lifts the cells that floor on it: a _higher_
 * change is made when every other cell it moves only goes up, and it names those `lifted` cells.
 * A _cheaper_ change the table cannot make without moving another cell (the floors are shared by
 * every size) is dropped with its reason. Each accepted change is a `config` improvement fact
 * (subject {@link routingConfigSubject}) carrying numbers only (D-by), and the evidence beside the
 * scorecard ({@link RoutingEvidence}): none (`routing.replay_planned` 0), or the graded tier replay
 * that backs it (`routing.replay_verdict`, `routing.replay_trials`). The tier replay itself is
 * `routing-replay.ts`'s; the routing step decides which evidence a change carries, and withholds
 * the fact while a replay runs or when it does not back the change.
 */
import {
  DEFAULT_ROUTING_TABLE,
  escalationSteps,
  isEventOfType,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  QA_AUTHOR_MIN_TIER,
  readEventData,
  routedByDifficulty,
  routedStartTier,
  routingConfigSubject,
  ROUTING_FACT_METRICS,
  ROUTING_REPLAY_VERDICT_CODES,
  RoutingScorecardSchema,
  RoutingTableSchema,
  taskRiskClass,
  TIER_ORDER,
  tierRank,
  type Attribution,
  type LookbackPace,
  type ModelTier,
  type RoutingReplayResult,
  type RoutingRoleOverride,
  type RoutingScorecard,
  type RoutingTable,
  type TaskRiskClass,
  type TaskSize,
  type VtcEvent,
} from "@vtc/shared";
import { isRoleFailure } from "./attribution.js";
import { writeRepoFileAtomic } from "./files.js";
import type { ReplayTask } from "./replay.js";
import {
  insufficient,
  mean,
  metricsOf,
  proportion,
  taskInfo,
  traceOutcomes,
  type MetricValue,
} from "./scorecards.js";
import { buildTraces, traceRef, traceSplit, type Trace } from "./traces.js";

export type RoutingCell = RoutingScorecard["cells"][number];
type StartReason = RoutingCell["start_reason"];

const SIZES: readonly TaskSize[] = ["S", "M", "L"];
const RISKS: readonly TaskRiskClass[] = ["none", "tagged", "high"];
const START_REASONS: ReadonlySet<string> = new Set<StartReason>(["rule", "planner_hint", "role"]);
const MAX_CELLS = 1000;

const higherOf = (a: ModelTier, b: ModelTier): ModelTier => (tierRank(a) >= tierRank(b) ? a : b);

/**
 * The start tier the routing table gives `role` for a task of `size` and `risk` (D-cm, reading
 * 218(2)), before the project's `routing.min_tier` / `max_tier` and QA author's floor: the shared
 * rule (`routedStartTier` in `@vtc/shared`, contracts 5.5.0), the one engine core's router
 * dispatches with, so Lookback measures against the start tier the engine picks. Re-exported for
 * this module's callers.
 */
export { routedStartTier };

// ----------------------------------------------------------------- scorecard

interface TaskShape {
  readonly size: TaskSize;
  readonly risk: TaskRiskClass;
}

/** Each task's size and risk class (`task.created`, the latest wins), by `<run>:<task>`. */
const taskShapes = (events: readonly VtcEvent[], table: RoutingTable): Map<string, TaskShape> => {
  const shapes = new Map<string, TaskShape>();
  for (const event of events) {
    if (!isEventOfType(event, "task.created")) continue;
    const { task } = readEventData(event);
    shapes.set(`${event.run}:${task.id}`, { size: task.size, risk: taskRiskClass(task, table) });
  }
  return shapes;
};

interface Dispatch {
  readonly tier?: ModelTier;
  readonly reason?: string;
  /** `role.dispatched.tier_clamped`: the project's bounds or QA author's floor moved the tier. */
  readonly clamped: boolean;
  readonly replay: boolean;
  /** The task's fix round when it was dispatched (its last `task.status_changed.round`, at least 1). */
  readonly round: number;
}

/**
 * Each dispatch's tier, tier reason, clamp, whether it is a replay trial and the round its task was
 * in, by `<run>:<action_id>`.
 */
const dispatchFacts = (events: readonly VtcEvent[]): Map<string, Dispatch> => {
  const out = new Map<string, Dispatch>();
  const rounds = new Map<string, number>();
  for (const event of events) {
    if (isEventOfType(event, "task.status_changed")) {
      if (event.task !== undefined)
        rounds.set(`${event.run}:${event.task}`, readEventData(event).round);
      continue;
    }
    if (!isEventOfType(event, "role.dispatched")) continue;
    const data = readEventData(event);
    const round = event.task === undefined ? undefined : rounds.get(`${event.run}:${event.task}`);
    out.set(`${event.run}:${data.action_id}`, {
      ...(data.tier === undefined ? {} : { tier: data.tier }),
      ...(data.tier_reason === undefined ? {} : { reason: data.tier_reason }),
      clamped: data.tier_clamped === true,
      replay: data.purpose === "lookback_replay",
      round: Math.max(1, round ?? 1),
    });
  }
  return out;
};

/**
 * Whether the role escalated on a task it started on `start` (D-cv): one of its dispatches ran in a
 * round in which the shared rule (`escalationSteps`) moves the start up, or was logged as an
 * `escalation`. The rule counts only for a start below Top: a Top start has no tier to escalate
 * to, so its later rounds are fix rounds on Top, not escalations.
 */
const escalatedOn = (
  start: ModelTier,
  traces: readonly Trace[],
  facts: ReadonlyMap<string, Dispatch>,
): boolean => {
  const canRise = tierRank(start) < tierRank("top");
  return traces.some((t) => {
    const fact = facts.get(traceRef(t));
    return (
      fact !== undefined &&
      (fact.reason === "escalation" || (canRise && escalationSteps(start, fact.round) > 0))
    );
  });
};

/** Each submitted dispatch's reported cost (`null`: none), by `<run>:<action_id>`. */
const dispatchCosts = (events: readonly VtcEvent[]): Map<string, number | null> => {
  const out = new Map<string, number | null>();
  for (const event of events) {
    if (!isEventOfType(event, "role.submitted")) continue;
    const priced = event.cost_usd;
    out.set(
      `${event.run}:${readEventData(event).action_id}`,
      typeof priced === "number" ? priced : null,
    );
  }
  return out;
};

/** The routed start of one task's (role, mode): the cell it falls in and all its dispatches. */
interface TaskStart {
  readonly key: string;
  readonly first: Trace & { readonly task: string };
  readonly cell: Omit<RoutingCell, "tasks" | "metrics" | "escalated" | "cost_per_task_usd">;
  readonly traces: Trace[];
}

const roleTaskKey = (t: { run: string; task: string; role: string; mode?: string }): string =>
  `${t.run}:${t.task}:${t.role}:${t.mode ?? ""}`;

const cellKey = (c: TaskStart["cell"]): string =>
  [c.role, c.mode ?? "", c.host, c.size, c.risk, c.start_tier, c.start_reason].join("\n");

/** Every task's routed start per (role, mode), with the cell it names; replay trials left out. */
const taskStarts = (
  events: readonly VtcEvent[],
  table: RoutingTable,
): { starts: TaskStart[]; traces: Trace[]; facts: Map<string, Dispatch> } => {
  const facts = dispatchFacts(events);
  const traces = buildTraces(events, () => undefined).filter(
    (t) => facts.get(traceRef(t))?.replay !== true,
  );
  const shapes = taskShapes(events, table);
  const byRoleTask = new Map<string, Trace[]>();
  for (const t of traces) {
    if (t.task === undefined) continue;
    const key = roleTaskKey({ ...t, task: t.task });
    const list = byRoleTask.get(key);
    if (list === undefined) byRoleTask.set(key, [t]);
    else list.push(t);
  }
  const starts: TaskStart[] = [];
  for (const [key, list] of byRoleTask) {
    const first = list[0];
    if (first?.task === undefined) continue;
    const shape = shapes.get(`${first.run}:${first.task}`);
    const fact = facts.get(traceRef(first));
    if (shape === undefined || fact?.tier === undefined || fact.reason === undefined) continue;
    if (!START_REASONS.has(fact.reason)) continue;
    // a clamped start measures the project's bound; QA author's floor is the one clamp kept
    const floored =
      first.role === "qa" && first.mode === "author" && fact.tier === QA_AUTHOR_MIN_TIER;
    if (fact.clamped && !floored) continue;
    starts.push({
      key,
      first: { ...first, task: first.task },
      cell: {
        role: first.role,
        ...(first.mode === undefined ? {} : { mode: first.mode }),
        host: first.host,
        size: shape.size,
        risk: shape.risk,
        start_tier: fact.tier,
        start_reason: fact.reason as StartReason,
      },
      traces: list,
    });
  }
  return { starts, traces, facts };
};

/**
 * The routing scorecard of the history (see the module comment). `attributions` decide which
 * dispatches failed (`tokens_per_success`); pass the trusted rows (`readAttributions`).
 */
export const computeRoutingScorecard = (input: {
  /** Events of every run the scorecard covers. */
  readonly history: readonly VtcEvent[];
  readonly attributions?: readonly Attribution[];
  readonly graderBundleSha: string;
  readonly now: Date;
  /** The table that classes a task's risk (`high_risk_tags`); default `DEFAULT_ROUTING_TABLE`. */
  readonly table?: RoutingTable;
}): RoutingScorecard => {
  const table = input.table ?? DEFAULT_ROUTING_TABLE;
  const { starts, traces, facts } = taskStarts(input.history, table);
  const failed = new Set((input.attributions ?? []).filter(isRoleFailure).map(traceRef));
  const outcomes = new Map(
    traceOutcomes(input.history, traces, failed).map((o) => [traceRef(o.trace), o]),
  );
  const tasks = taskInfo(input.history);
  const costs = dispatchCosts(input.history);
  const groups = new Map<string, TaskStart[]>();
  for (const start of starts) {
    const key = cellKey(start.cell);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [start]);
    else list.push(start);
  }
  const cells: RoutingCell[] = [];
  const firsts: string[] = [];
  for (const group of groups.values()) {
    const head = group[0];
    if (head === undefined) continue;
    const rows = group.flatMap((s) =>
      s.traces.flatMap((t) => {
        const o = outcomes.get(traceRef(t));
        return o === undefined ? [] : [o];
      }),
    );
    const escalated = group.filter((s) => escalatedOn(s.cell.start_tier, s.traces, facts)).length;
    const priced: number[] = [];
    for (const s of group) {
      const submitted = s.traces.filter((t) => t.end?.kind === "submitted");
      if (submitted.length === 0) continue;
      const each = submitted.map((t) => costs.get(traceRef(t)) ?? null);
      if (each.every((c): c is number => c !== null)) priced.push(each.reduce((a, b) => a + b, 0));
    }
    const cost: MetricValue =
      mean(
        priced.reduce((a, b) => a + b, 0),
        priced.length,
      ) ?? insufficient(0);
    cells.push({
      ...head.cell,
      tasks: group.length,
      metrics: metricsOf(rows, tasks),
      escalated: proportion(escalated, group.length) ?? insufficient(0),
      cost_per_task_usd:
        cost.value === null ? cost : { ...cost, value: Math.round(cost.value * 1e6) / 1e6 },
    });
    firsts.push(...group.map((s) => s.first.ts));
  }
  firsts.sort();
  const at = input.now.toISOString();
  const ordered = cells
    .sort((a, b) => b.tasks - a.tasks)
    .slice(0, MAX_CELLS)
    .sort(
      (a, b) =>
        a.role.localeCompare(b.role) ||
        (a.mode ?? "").localeCompare(b.mode ?? "") ||
        a.host.localeCompare(b.host) ||
        SIZES.indexOf(a.size) - SIZES.indexOf(b.size) ||
        RISKS.indexOf(a.risk) - RISKS.indexOf(b.risk) ||
        tierRank(a.start_tier) - tierRank(b.start_tier) ||
        a.start_reason.localeCompare(b.start_reason),
    );
  return RoutingScorecardSchema.parse({
    v: 1,
    grader_bundle_sha: input.graderBundleSha,
    window: { from: firsts[0] ?? at, to: firsts.at(-1) ?? at },
    cells: ordered,
    written_at: at,
  });
};

/** Writes the routing scorecard at `LOOKBACK_REPO.routingScorecard`; returns that path. */
export const writeRoutingScorecard = async (
  projectRoot: string,
  card: RoutingScorecard,
): Promise<string> => {
  await writeRepoFileAtomic(
    projectRoot,
    LOOKBACK_REPO.routingScorecard,
    `${JSON.stringify(RoutingScorecardSchema.parse(card), null, 2)}\n`,
  );
  return LOOKBACK_REPO.routingScorecard;
};

// ----------------------------------------------------------------- proposals

/** A cell a _higher_ change lifts with it. */
export interface RoutingLift {
  readonly size: TaskSize;
  readonly risk: TaskRiskClass;
  readonly from: ModelTier;
  readonly to: ModelTier;
}

/** One change to the routing table Lookback proposes, with the cells that back it. */
export interface RoutingChange {
  readonly role: string;
  readonly size: TaskSize;
  readonly risk: TaskRiskClass;
  /** `routing.<role>.<size>.<risk>` ({@link routingConfigSubject}). */
  readonly subject: string;
  readonly direction: "cheaper" | "higher";
  readonly from: ModelTier;
  readonly to: ModelTier;
  /** `shared`: the table's own cell; `role`: the role's `roles.<role>` override. */
  readonly scope: "shared" | "role";
  /**
   * Other cells a _higher_ change lifts with it, because they floor on the field it raises (a
   * tagged cell on `by_size`, a size's tagged cell on `tagged_floor`); each only goes up.
   */
  readonly lifted: readonly RoutingLift[];
  /** The current start tier's cell (the group with the most tasks). */
  readonly current: RoutingCell;
  /** The cheaper tier's cell that matched quality (a `cheaper` change only). */
  readonly candidate?: RoutingCell;
}

/**
 * What backs a change beside the scorecard (D-cn, reading 247(6)): nothing (`scorecard`, the fact
 * says `routing.replay_planned` 0), or the graded tier replay that backs it
 * (`routingReplayBacks`), whose verdict and trial count the fact carries. A change whose replay is
 * due or started and not graded raises no fact at all (reading 249).
 */
export type RoutingEvidence =
  | { readonly kind: "scorecard" }
  | { readonly kind: "replay"; readonly result: RoutingReplayResult };

const SCORECARD_ONLY: RoutingEvidence = { kind: "scorecard" };

/** The trials a graded tier replay counted, both arms. */
export const routingReplayTrialCount = (result: RoutingReplayResult): number =>
  result.per_task.reduce((n, t) => n + t.a.length + t.b.length, 0);

/**
 * A `config` improvement fact (D-cd, D-cs (3)) as engine core hands it to the upstream module:
 * the shape of the upstream module's `AutomationFact` of type `improvement`. Numbers only (D-by).
 */
export interface RoutingConfigFact {
  readonly type: "improvement";
  readonly kind: "config";
  readonly subject: string;
  readonly role: string;
  readonly metrics: Readonly<Record<string, number>>;
  readonly at: string;
}

export interface RoutingProposals {
  /** The proposed `DEFAULT_ROUTING_TABLE` value; `null` when nothing changes. */
  readonly table: RoutingTable | null;
  readonly changes: readonly RoutingChange[];
  /** Each change's fact on the scorecard alone, in the changes' order. */
  readonly facts: readonly RoutingConfigFact[];
  /**
   * Changes the scorecard backs but the table cannot make alone, with why: a _cheaper_ start that
   * would move another cell, or a _higher_ one that would move a cell two tiers.
   */
  readonly dropped: readonly { readonly subject: string; readonly reason: string }[];
}

type GroupDecision =
  | {
      readonly kind: "higher" | "cheaper";
      readonly to: ModelTier;
      readonly current: RoutingCell;
      readonly candidate?: RoutingCell;
    }
  /** `keep`: a cheaper tier was compared and fell short; `steady`: nothing to change. */
  | { readonly kind: "keep" | "steady"; readonly current: RoutingCell };

const PASS_METRICS = ["first_round_gate_pass", "review_pass"] as const;

const readable = (cell: RoutingCell | undefined): cell is RoutingCell =>
  cell !== undefined && cell.tasks >= LOOKBACK_LIMITS.routingMinTasks;

const keepsEscalating = (cell: RoutingCell): boolean =>
  cell.escalated.value !== null &&
  cell.escalated.value * 100 >= LOOKBACK_LIMITS.routingEscalationPct;

/** Whether `cheaper` matches `current`'s quality; `undefined` when no pass rate compares. */
const matchesQuality = (current: RoutingCell, cheaper: RoutingCell): boolean | undefined => {
  let compared = 0;
  for (const id of PASS_METRICS) {
    const now = current.metrics[id]?.value ?? null;
    if (now === null) continue;
    const then = cheaper.metrics[id]?.value ?? null;
    if (then === null) return undefined;
    compared += 1;
    // points, with a little room for floating-point noise (0.95 - 0.9 is not exactly 0.05)
    if ((now - then) * 100 > LOOKBACK_LIMITS.routingQualityMarginPct + 1e-9) return false;
  }
  return compared > 0 ? !keepsEscalating(cheaper) : undefined;
};

/** One (role, mode, host, size, risk) group's decision, or `undefined` without readable evidence. */
const decide = (
  cells: readonly RoutingCell[],
  current: ModelTier,
  floor: ModelTier,
): GroupDecision | undefined => {
  const pick = (tier: ModelTier): RoutingCell | undefined => {
    const at = cells.filter((c) => c.start_tier === tier);
    const best = (list: readonly RoutingCell[]) => [...list].sort((a, b) => b.tasks - a.tasks)[0];
    // a cheaper tier's evidence is never a Planner-hinted cell: the Planner put those tasks there
    // because their size and tags misjudge them (reading 218(3)), so they do not speak for the cell
    return tier === current
      ? (best(at.filter((c) => c.start_reason === "rule")) ?? best(at))
      : best(at.filter((c) => c.start_reason !== "planner_hint"));
  };
  const now = pick(current);
  if (!readable(now)) return undefined;
  if (keepsEscalating(now)) {
    const up = TIER_ORDER[tierRank(current) + 1];
    return up === undefined ? undefined : { kind: "higher", to: up, current: now };
  }
  let compared = false;
  for (const tier of TIER_ORDER.slice(tierRank(floor), tierRank(current))) {
    const cheaper = pick(tier);
    if (!readable(cheaper)) continue;
    const match = matchesQuality(now, cheaper);
    if (match === undefined) continue;
    compared = true;
    if (match) return { kind: "cheaper", to: tier, current: now, candidate: cheaper };
  }
  return { kind: compared ? "keep" : "steady", current: now };
};

/** The effective start tier of every (size, risk) cell for `role`. */
const grid = (table: RoutingTable, role: string): Map<string, ModelTier> => {
  const out = new Map<string, ModelTier>();
  for (const size of SIZES)
    for (const risk of RISKS) out.set(`${size}.${risk}`, routedStartTier(table, role, size, risk));
  return out;
};

/** The table with `role`'s (or the shared, `role` undefined) field for (size, risk) set to `to`. */
const withCell = (
  table: RoutingTable,
  role: string | undefined,
  size: TaskSize,
  risk: TaskRiskClass,
  to: ModelTier,
): RoutingTable => {
  const field: Partial<RoutingRoleOverride> =
    risk === "none"
      ? {
          by_size: {
            ...(role === undefined ? table.by_size : table.roles?.[role]?.by_size),
            [size]: to,
          },
        }
      : risk === "tagged"
        ? { tagged_floor: to }
        : { high_floor: to };
  if (role === undefined) {
    return {
      ...table,
      ...(field.by_size === undefined ? {} : { by_size: { ...table.by_size, ...field.by_size } }),
      ...(field.tagged_floor === undefined ? {} : { tagged_floor: field.tagged_floor }),
      ...(field.high_floor === undefined ? {} : { high_floor: field.high_floor }),
    };
  }
  const own = table.roles?.[role] ?? {};
  return { ...table, roles: { ...table.roles, [role]: { ...own, ...field } } };
};

/** A routed role that has no override: how the shared cells read. */
const SHARED_PROBE = "__shared__";

/**
 * Pure: a change's fact metrics (D-by: numbers only; the fixed names are `ROUTING_FACT_METRICS`),
 * with the evidence beside the scorecard.
 */
export const routingFactMetrics = (
  change: RoutingChange,
  evidence: RoutingEvidence = SCORECARD_ONLY,
): Record<string, number> => {
  const m = ROUTING_FACT_METRICS;
  const metrics: Record<string, number> = {
    [m.fromTier]: tierRank(change.from),
    [m.toTier]: tierRank(change.to),
    [m.currentTier]: tierRank(change.current.start_tier),
    [m.shared]: change.scope === "shared" ? 1 : 0,
    [m.replayPlanned]: evidence.kind === "replay" ? 1 : 0,
    "routing.tasks.current": change.current.tasks,
    [m.lifted]: change.lifted.length,
  };
  if (evidence.kind === "replay") {
    metrics[m.replayVerdict] = ROUTING_REPLAY_VERDICT_CODES[evidence.result.verdict];
    metrics[m.replayTrials] = routingReplayTrialCount(evidence.result);
  }
  for (const lift of change.lifted)
    metrics[`${m.liftedPrefix}${lift.size.toLowerCase()}_${lift.risk}`] = tierRank(lift.to);
  const put = (name: string, value: number | null | undefined): void => {
    if (value !== null && value !== undefined) metrics[name] = value;
  };
  put("routing.escalated.current", change.current.escalated.value);
  put("routing.cost_per_task_usd.current", change.current.cost_per_task_usd.value);
  for (const id of PASS_METRICS) put(`routing.${id}.current`, change.current.metrics[id]?.value);
  if (change.candidate !== undefined) {
    put("routing.tasks.candidate", change.candidate.tasks);
    put("routing.escalated.candidate", change.candidate.escalated.value);
    put("routing.cost_per_task_usd.candidate", change.candidate.cost_per_task_usd.value);
    for (const id of PASS_METRICS)
      put(`routing.${id}.candidate`, change.candidate.metrics[id]?.value);
  }
  return metrics;
};

const factOf = (change: RoutingChange, at: string): RoutingConfigFact => ({
  type: "improvement",
  kind: "config",
  subject: change.subject,
  role: change.role,
  metrics: routingFactMetrics(change),
  at,
});

/**
 * Pure (D-cn, D-cu): the routing-table changes the scorecard backs (see the module comment), the
 * proposed table value and each change's `config` fact on the scorecard alone.
 */
export const routingProposals = (
  scorecard: RoutingScorecard,
  table: RoutingTable = DEFAULT_ROUTING_TABLE,
): RoutingProposals => {
  // 1. each (role, mode, host, size, risk) group's decision, for the producers only (D-cu)
  const groups = new Map<string, RoutingCell[]>();
  for (const cell of scorecard.cells) {
    if (!routedByDifficulty(cell.role, cell.mode)) continue;
    const key = [cell.role, cell.mode ?? "", cell.host, cell.size, cell.risk].join("\n");
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [cell]);
    else list.push(cell);
  }
  const byCell = new Map<string, GroupDecision[]>();
  for (const cells of groups.values()) {
    const head = cells[0];
    if (head === undefined) continue;
    const floor = head.role === "qa" && head.mode === "author" ? QA_AUTHOR_MIN_TIER : "low";
    const current = higherOf(routedStartTier(table, head.role, head.size, head.risk), floor);
    const decision = decide(cells, current, floor);
    if (decision === undefined) continue;
    const key = `${head.role}\n${head.size}\n${head.risk}`;
    byCell.set(key, [...(byCell.get(key) ?? []), decision]);
  }
  // 2. one decision per (role, size, risk): higher wins; a group that kept blocks cheaper
  type Wanted = Omit<RoutingChange, "scope" | "subject" | "lifted">;
  const wanted: Wanted[] = [];
  const dropped: { subject: string; reason: string }[] = [];
  const best = (list: readonly GroupDecision[]) =>
    [...list].sort((a, b) => b.current.tasks - a.current.tasks)[0];
  for (const [key, decisions] of byCell) {
    const [role = "", size = "S", risk = "none"] = key.split("\n");
    const from = routedStartTier(table, role, size as TaskSize, risk as TaskRiskClass);
    const higher = decisions.filter((d) => d.kind === "higher");
    const cheaper = decisions.filter((d) => d.kind === "cheaper");
    const chosen =
      higher.length > 0 ? higher : decisions.some((d) => d.kind === "keep") ? [] : cheaper;
    const evidence = best(chosen);
    if (evidence === undefined || (evidence.kind !== "higher" && evidence.kind !== "cheaper"))
      continue;
    const to = chosen
      .map((d) => (d.kind === "higher" || d.kind === "cheaper" ? d.to : from))
      .reduce((a, b) => higherOf(a, b));
    if (to === from) continue;
    if (evidence.kind === "higher" && tierRank(to) - tierRank(from) > 1) {
      // QA author's start is floored above the table's: one tier up from the floor is two tiers
      // up in the table, and a higher change moves one tier at a time
      dropped.push({
        subject: routingConfigSubject(role, size as TaskSize, risk as TaskRiskClass),
        reason: `starting ${size}/${risk} on ${to} would move ${role}'s table start two tiers from ${from}; its start is floored above the table's`,
      });
      continue;
    }
    wanted.push({
      role,
      size: size as TaskSize,
      risk: risk as TaskRiskClass,
      direction: evidence.kind,
      from,
      to,
      current: evidence.current,
      ...(evidence.candidate === undefined ? {} : { candidate: evidence.candidate }),
    });
  }
  // 3. shared when two or more roles want the same cell change and no role with evidence objects
  const cellOf = (w: { size: string; risk: string }) => `${w.size}.${w.risk}`;
  const objecting = new Set<string>();
  for (const [key, decisions] of byCell) {
    const [role = "", size = "", risk = ""] = key.split("\n");
    if (decisions.some((d) => d.kind === "keep" || d.kind === "steady"))
      objecting.add(`${role}\n${size}.${risk}`);
  }
  const sharedKey = (w: Wanted) => `${cellOf(w)}\n${w.direction}\n${w.to}`;
  const backers = new Map<string, Wanted[]>();
  for (const w of wanted) backers.set(sharedKey(w), [...(backers.get(sharedKey(w)) ?? []), w]);
  const sharedOk = (w: Wanted): boolean => {
    const backing = backers.get(sharedKey(w)) ?? [];
    if (backing.length < 2) return false;
    const roles = new Set(backing.map((b) => b.role));
    const others = wanted.some((o) => cellOf(o) === cellOf(w) && !roles.has(o.role));
    const blocked = [...objecting].some((k) => {
      const [role = "", cell = ""] = k.split("\n");
      return cell === cellOf(w) && !roles.has(role);
    });
    return !others && !blocked;
  };
  // 4. apply in a stable order: a higher change may lift the cells that floor on it; a cheaper
  // one that moves a cell no evidence asked for is dropped
  wanted.sort(
    (a, b) =>
      a.role.localeCompare(b.role) ||
      SIZES.indexOf(a.size) - SIZES.indexOf(b.size) ||
      RISKS.indexOf(a.risk) - RISKS.indexOf(b.risk),
  );
  let next = table;
  const changes: RoutingChange[] = [];
  const sharedDone = new Map<string, readonly RoutingLift[]>();
  for (const w of wanted) {
    const subject = routingConfigSubject(w.role, w.size, w.risk);
    const scope = sharedOk(w) ? "shared" : "role";
    const done = scope === "shared" ? sharedDone.get(sharedKey(w)) : undefined;
    if (done !== undefined) {
      changes.push({ ...w, subject, scope, lifted: done });
      continue;
    }
    const probe = scope === "shared" ? SHARED_PROBE : w.role;
    const trial = withCell(next, scope === "shared" ? undefined : w.role, w.size, w.risk, w.to);
    const before = grid(next, probe);
    const after = grid(trial, probe);
    const others = [...after]
      .filter(([cell, tier]) => cell !== cellOf(w) && before.get(cell) !== tier)
      .map(([cell, to]) => ({ cell, from: before.get(cell) ?? to, to }));
    const reached = after.get(cellOf(w)) === w.to;
    const liftsOnly =
      w.direction === "higher" && others.every((o) => tierRank(o.to) > tierRank(o.from));
    if (!reached || (others.length > 0 && !liftsOnly)) {
      dropped.push({
        subject,
        reason: !reached
          ? `the table cannot start ${w.size}/${w.risk} on ${w.to} without changing another cell`
          : `starting ${w.size}/${w.risk} on ${w.to} would also move ${others.map((o) => o.cell).join(", ")}`,
      });
      continue;
    }
    const lifted: RoutingLift[] = others.map((o) => {
      const [size = "S", risk = "none"] = o.cell.split(".");
      return { size: size as TaskSize, risk: risk as TaskRiskClass, from: o.from, to: o.to };
    });
    next = trial;
    if (scope === "shared") sharedDone.set(sharedKey(w), lifted);
    changes.push({ ...w, subject, scope, lifted });
  }
  return {
    table: changes.length === 0 ? null : RoutingTableSchema.parse(next),
    changes,
    facts: changes.map((c) => factOf(c, scorecard.written_at)),
    dropped,
  };
};

/**
 * One routing-table cell Lookback proposes to change, as engine core's daemon takes it through its
 * `RoutingLookback` seam (`RoutingProposalCell`) and turns it into a `config` fact
 * (`routingConfigFact`, subject {@link routingConfigSubject}): the cell, the change's numbers (the
 * fact's metrics, D-by) and a sentence in VTC's vocabulary naming the `DEFAULT_ROUTING_TABLE` edit.
 */
export interface RoutingProposalCell {
  readonly role: string;
  readonly size: TaskSize;
  readonly risk: TaskRiskClass;
  readonly metrics: Readonly<Record<string, number>>;
  readonly detail: string;
}

/** The `DEFAULT_ROUTING_TABLE` field a change sets: shared, or under `roles.<role>`. */
const tableField = (change: RoutingChange): string => {
  const field =
    change.risk === "none"
      ? `by_size.${change.size}`
      : change.risk === "tagged"
        ? "tagged_floor"
        : "high_floor";
  return change.scope === "shared" ? field : `roles.${change.role}.${field}`;
};

const percent = (value: number | null): string =>
  value === null ? "an unknown share" : `${String(Math.round(value * 100))}%`;

/** Why the scorecard backs the change, in numbers. */
const evidenceOf = (change: RoutingChange): string => {
  const { current, candidate } = change;
  if (change.direction === "higher" || candidate === undefined)
    return `${percent(current.escalated.value)} of ${String(current.tasks)} tasks escalated from ${current.start_tier}`;
  const rates = PASS_METRICS.flatMap((id) => {
    const now = current.metrics[id]?.value ?? null;
    const then = candidate.metrics[id]?.value ?? null;
    return now === null || then === null ? [] : [`${id} ${String(then)} against ${String(now)}`];
  });
  return `${String(candidate.tasks)} tasks started on ${candidate.start_tier} matched quality within ${String(LOOKBACK_LIMITS.routingQualityMarginPct)} points (${rates.join(", ")}), ${percent(candidate.escalated.value)} escalated`;
};

const signedPct = (value: number): string => `${value > 0 ? "+" : ""}${String(Math.round(value))}%`;

/** What the evidence beside the scorecard says, in VTC's vocabulary. */
const replaySentence = (change: RoutingChange, evidence: RoutingEvidence): string => {
  if (evidence.kind === "scorecard")
    return "No tier replay backs it; the scorecard is the evidence.";
  const r = evidence.result;
  const cost = r.cost_delta_pct === null ? "" : `, cost ${signedPct(r.cost_delta_pct)}`;
  return `A tier replay backs it: ${r.verdict} over ${String(routingReplayTrialCount(r))} trials of ${String(r.per_task.length)} held-out tasks, ${change.to} against ${change.from} on the same prompt (tokens ${signedPct(r.tokens_delta_pct)}${cost}).`;
};

/**
 * Pure (D-cn): each change of `proposals` as the cell engine core's routing seam returns, in the
 * changes' order. `evidence` says what backs each change beside the scorecard; `null` withholds the
 * change (a tier replay still runs, or it does not back the change); absent, every change carries
 * the scorecard alone. The detail names the edit the PR makes (spine §5 reading 219: only the
 * values of `DEFAULT_ROUTING_TABLE` change), the cells it lifts and the evidence; it holds no
 * project data.
 */
export const routingProposalCells = (
  proposals: RoutingProposals,
  evidence: (change: RoutingChange) => RoutingEvidence | null = () => SCORECARD_ONLY,
): RoutingProposalCell[] =>
  proposals.changes.flatMap((change) => {
    const backing = evidence(change);
    if (backing === null) return [];
    const lifts = change.lifted.map((l) => `${l.size}/${l.risk} on ${l.to}`);
    const detail = [
      `${change.role} ${change.size}/${change.risk}: start on ${change.to} instead of ${change.from} (${evidenceOf(change)}).`,
      `In DEFAULT_ROUTING_TABLE (packages/shared/src/tier-routing.ts) set ${tableField(change)} to "${change.to}"${change.scope === "shared" ? ", shared by every routed role" : ""}.`,
      ...(lifts.length === 0 ? [] : [`This also starts ${lifts.join(", ")}.`]),
      replaySentence(change, backing),
    ].join(" ");
    return [
      {
        role: change.role,
        size: change.size,
        risk: change.risk,
        metrics: routingFactMetrics(change, backing),
        detail: detail.slice(0, 2000),
      },
    ];
  });

/**
 * The held-out tasks a tier replay of `cell` runs (the first dispatch of each, at most
 * `pace.failureTasks` that failed at their start tier and `pace.regressionTasks` that did not, in
 * log order so the sample is stable as the history grows). A task failed at its start tier when
 * the role escalated on it (D-cv, as the scorecard counts it) or its first dispatch is an attributed
 * role failure. A train-split task is never replayed (AD-21 rule 6).
 */
export const routingReplayTasks = (input: {
  readonly history: readonly VtcEvent[];
  readonly attributions?: readonly Attribution[];
  readonly cell: Pick<RoutingCell, "role" | "mode" | "host" | "size" | "risk" | "start_tier">;
  readonly table?: RoutingTable;
  readonly pace?: Pick<LookbackPace, "failureTasks" | "regressionTasks">;
}): ReplayTask[] => {
  const { starts, facts } = taskStarts(input.history, input.table ?? DEFAULT_ROUTING_TABLE);
  const failed = new Set((input.attributions ?? []).filter(isRoleFailure).map(traceRef));
  const { cell } = input;
  const limit = {
    failures: input.pace?.failureTasks ?? LOOKBACK_LIMITS.replayFailureTasks,
    regression: input.pace?.regressionTasks ?? LOOKBACK_LIMITS.replayRegressionTasks,
  };
  const picked = { failures: [] as ReplayTask[], regression: [] as ReplayTask[] };
  for (const s of starts.sort(
    (a, b) => a.first.ts.localeCompare(b.first.ts) || a.first.seq - b.first.seq,
  )) {
    const c = s.cell;
    if (
      c.role !== cell.role ||
      c.mode !== cell.mode ||
      c.host !== cell.host ||
      c.size !== cell.size ||
      c.risk !== cell.risk ||
      c.start_tier !== cell.start_tier ||
      traceSplit(s.first) !== "holdout" ||
      s.first.end?.kind !== "submitted"
    )
      continue;
    const fail = failed.has(traceRef(s.first)) || escalatedOn(c.start_tier, s.traces, facts);
    const bucket = fail ? picked.failures : picked.regression;
    if (bucket.length >= (fail ? limit.failures : limit.regression)) continue;
    bucket.push({
      trace: s.first.trace,
      run: s.first.run,
      task: s.first.task,
      regressionSet: !fail,
    });
  }
  return [...picked.failures, ...picked.regression];
};
