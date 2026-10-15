/**
 * Difficulty-based routing (H-9, D-cm; spine §5 reading 218). Pure: the tier a role run starts on
 * and why. Every role run dispatched for a task (the Engineer family, QA in author and judge mode
 * and the task's reviewers) starts on the tier its task's difficulty picks:
 * - the Planner's hint (`task.tier_hint`) when there is one (reason `planner_hint`; never below
 *   `high_floor` for a high-risk task, reading 218(2), `clamped` when the floor moves it), else the
 *   routing table (`DEFAULT_ROUTING_TABLE`, reason `rule`): `by_size` for a task with no risk tag,
 *   at least `tagged_floor` for a tagged one, at least `high_floor` for a high-risk one
 *   (`taskRiskClass`), each cell taken from the role's own `roles[role]` override when it names one;
 * - then the project's `routing.min_tier` / `max_tier` (`routingFor`), then QA author's floor
 *   (`QA_AUTHOR_MIN_TIER`, spec §5.2: the spec rule wins over `max_tier`).
 * A role run with no task, and every run under `routing.start: role`, starts on the role's own
 * `role.yaml` tier (reason `role`), clamped the same way. The existing rules move from the routed
 * start: one tier up after 2 failed rounds (`escalation`), a reviewer one tier down at 70% of the
 * budget or past its share (`budget_drop`), each clamped again.
 */
import {
  clampTier,
  DEFAULT_ROUTING_TABLE,
  QA_AUTHOR_MIN_TIER,
  routedStartTier,
  routingFor,
  taskRiskClass,
  tierRank,
  type ModelTier,
  type Risk,
  type RoutingConfig,
  type RoutingTable,
  type TaskSize,
  type TierHint,
  type TierReason,
} from "@vtc/shared";
import { tierDown, tierUp } from "./loop.js";

/** The tier a dispatch runs on, why, and whether the project's bounds or QA's floor moved it. */
export interface TierRoute {
  readonly tier: ModelTier;
  readonly reason: TierReason;
  readonly clamped: boolean;
}

/** What routing reads of a task. */
export interface RouteTask {
  readonly size: TaskSize;
  readonly risk: Risk;
  readonly risk_tags: readonly string[];
  readonly tier_hint?: TierHint | undefined;
}

export interface RouteInput {
  readonly role: string;
  readonly mode?: string | undefined;
  /** The task the run is dispatched for; absent: a role the rule does not route (`role`). */
  readonly task?: RouteTask | undefined;
  /** The role's own `role.yaml` tier on the dispatch's host (its mode's first). */
  readonly roleTier: ModelTier;
  /** The project config's `routing` (absent: by difficulty, the full tier range). */
  readonly config?: { readonly routing?: RoutingConfig | undefined } | undefined;
  /** Absent: {@link DEFAULT_ROUTING_TABLE}. */
  readonly table?: RoutingTable | undefined;
}

/** A change of tier from the routed start (the existing rules, spec §6.3 step 9 and §11). */
export type TierChange = "escalation" | "budget_drop";

const higher = (a: ModelTier, b: ModelTier): ModelTier => (tierRank(a) >= tierRank(b) ? a : b);

const qaAuthor = (input: Pick<RouteInput, "role" | "mode">): boolean =>
  input.role === "qa" && input.mode === "author";

/**
 * Pure: the routing table's tier for a task and role (no hint, no clamp): the shared rule
 * (`routedStartTier`, contracts 5.5.0), which Lookback, the compiler and the cli read too.
 */
export const ruleTier = (
  task: RouteTask,
  role: string,
  table: RoutingTable = DEFAULT_ROUTING_TABLE,
): ModelTier => routedStartTier(table, role, task.size, taskRiskClass(task, table));

/**
 * `candidate` raised to `floor` (if any), inside the project's bounds, then QA author's floor.
 * `clamped` says whether any of them moved `candidate`.
 */
const settle = (
  input: RouteInput,
  candidate: ModelTier,
  reason: TierReason,
  floor?: ModelTier,
): TierRoute => {
  const { min, max } = routingFor(input.config);
  let tier = clampTier(floor === undefined ? candidate : higher(candidate, floor), min, max);
  if (qaAuthor(input)) tier = higher(tier, QA_AUTHOR_MIN_TIER);
  return { tier, reason, clamped: tier !== candidate };
};

/**
 * The floor under a Planner hint: a high-risk task never starts below its `high_floor` (reading
 * 218(2)), so a hint cannot lower the tier of a high-risk task (or its Security review) below it.
 */
const hintFloor = (
  task: RouteTask,
  role: string,
  table: RoutingTable = DEFAULT_ROUTING_TABLE,
): ModelTier | undefined =>
  taskRiskClass(task, table) === "high"
    ? (table.roles?.[role]?.high_floor ?? table.high_floor)
    : undefined;

/** Pure: the tier a role run starts on (D-cm). */
export const startTier = (input: RouteInput): TierRoute => {
  const task = input.task;
  if (task === undefined || routingFor(input.config).start === "role")
    return settle(input, input.roleTier, "role");
  if (task.tier_hint !== undefined)
    return settle(
      input,
      task.tier_hint.tier,
      "planner_hint",
      hintFloor(task, input.role, input.table),
    );
  return settle(input, ruleTier(task, input.role, input.table), "rule");
};

/**
 * Pure: the tier a role run is dispatched on: its start ({@link startTier}), or one tier up from it
 * (`escalation`) or down (`budget_drop`), clamped again. `clamped` says whether the bounds moved the
 * tier this route asked for.
 */
export const routeTier = (input: RouteInput, change?: TierChange): TierRoute => {
  const start = startTier(input);
  if (change === undefined) return start;
  return settle(input, change === "escalation" ? tierUp(start.tier) : tierDown(start.tier), change);
};
