/**
 * Difficulty-based model routing (H-9, D-cm; spine §5 readings 217–219). New in 5.4.0.
 *
 * A per-task role (the Engineer family, QA in both modes and the task's reviewers) starts on the
 * tier the task's difficulty picks, not only on its `role.yaml` tier:
 * - the Planner's size and risk pick the start tier from the routing table (`RoutingTable`,
 *   {@link DEFAULT_ROUTING_TABLE}): S with no risk tag Low, M or a tagged S Mid, L or any
 *   high-risk tag (or `risk: high`) Top;
 * - the Planner may name a reason-coded {@link TierHint} for one task, used only when it clearly
 *   helps; the engine clamps every chosen tier to the project's `routing.min_tier` /
 *   `routing.max_tier` ({@link routingFor}) and logs the result;
 * - QA in author mode never runs on Low ({@link QA_AUTHOR_MIN_TIER}, spec §5.2), whatever the
 *   table, a hint or `max_tier` says;
 * - the existing rules stay: one tier up after 2 failed rounds (a fresh session), reviewers one
 *   tier down at 70% of the budget, park at 100%; `hosts.models` still maps a tier to a model id.
 * `role.dispatched` records the tier and why (`tier_reason`, {@link TierReasonSchema}).
 *
 * The routing function and the dispatch wiring are engine core's (`core/routing.ts`); this file
 * holds the shapes, the table and the pure pieces every consumer must agree on. Lookback proposes
 * changes to {@link DEFAULT_ROUTING_TABLE} through the AD-27 issue → PR path (D-cn): such a PR
 * changes values only, which is not a schema change.
 */
import { z } from "zod";
import {
  ModelTierSchema,
  RoleIdSchema,
  SlugSchema,
  type Effort,
  type ModelTier,
  type Risk,
} from "./primitives.js";

/** Tiers from cheapest to strongest. */
export const TIER_ORDER: readonly ModelTier[] = ["low", "mid", "top"];

/** Pure: a tier's rank in {@link TIER_ORDER} (low 0, mid 1, top 2). */
export const tierRank = (tier: ModelTier): number => TIER_ORDER.indexOf(tier);

/** Pure: `tier` held inside `[min, max]` (an inverted range is treated as `[max, min]`). */
export const clampTier = (
  tier: ModelTier,
  min: ModelTier = "low",
  max: ModelTier = "top",
): ModelTier => {
  const [lo, hi] = tierRank(min) <= tierRank(max) ? [min, max] : [max, min];
  if (tierRank(tier) < tierRank(lo)) return lo;
  if (tierRank(tier) > tierRank(hi)) return hi;
  return tier;
};

/** QA in author mode never runs on the bottom tier (spec §5.2): its floor, after every clamp. */
export const QA_AUTHOR_MIN_TIER: ModelTier = "mid";

/**
 * Why the Planner asks for another start tier than the table's. Raising: the change crosses
 * modules, carries new logic, concurrency, subtle invariants, a large context or a stack the
 * repo rarely uses. Lowering: the change is mechanical, boilerplate, docs or config only, or so
 * fully specified that a cheaper model suffices.
 */
export const TierHintReasonSchema = z.enum([
  "cross_cutting",
  "novel_logic",
  "concurrency",
  "subtle_invariants",
  "large_context",
  "unfamiliar_stack",
  "mechanical",
  "boilerplate",
  "docs_or_config",
  "well_specified",
]);
export type TierHintReason = z.infer<typeof TierHintReasonSchema>;

/**
 * The Planner's optional start-tier override for one task (D-cm), on `TaskDraft.tier_hint` and
 * kept on the task (`Task.tier_hint`) so replay sees it. On a high-risk task (`taskRiskClass`
 * `high`) the hint is first raised to the role's `high_floor` (a high-risk task never starts below
 * it, spine §5 readings 218(2) and 228); the engine then clamps it to the project's
 * `[min_tier, max_tier]` and, for QA author, to {@link QA_AUTHOR_MIN_TIER}. Either move is
 * reported as `tier_clamped: true`.
 */
export const TierHintSchema = z.strictObject({
  tier: ModelTierSchema,
  reason: TierHintReasonSchema,
  /** One sentence for the human reading the plan; no code, no secrets. */
  detail: z.string().min(1).max(300).optional(),
});
export type TierHint = z.infer<typeof TierHintSchema>;

/**
 * Why a dispatch runs on its tier (`role.dispatched.tier_reason`, `RoleRunSummary.tier_reason`):
 * `role` the role's own `role.yaml` tier (a role the rule does not route, or `routing.start:
 * role`); `rule` the routing table; `planner_hint` the task's {@link TierHint}; `escalation` one
 * tier up after 2 failed rounds; `budget_drop` a reviewer one tier down at 70% of the budget or
 * past the reviewers' share.
 */
export const TierReasonSchema = z.enum([
  "role",
  "rule",
  "planner_hint",
  "escalation",
  "budget_drop",
]);
export type TierReason = z.infer<typeof TierReasonSchema>;

/** A task's risk as the routing table reads it: no tag, some tag, or a high-risk tag. */
export const TaskRiskClassSchema = z.enum(["none", "tagged", "high"]);
export type TaskRiskClass = z.infer<typeof TaskRiskClassSchema>;

/** One role's departures from the table's tiers (D-cn): only the cells a reviewed PR changed. */
export const RoutingRoleOverrideSchema = z.strictObject({
  by_size: z.partialRecord(z.enum(["S", "M", "L"]), ModelTierSchema).optional(),
  tagged_floor: ModelTierSchema.optional(),
  high_floor: ModelTierSchema.optional(),
});
export type RoutingRoleOverride = z.infer<typeof RoutingRoleOverrideSchema>;

/** The routing table (D-cm). Values change through a reviewed PR (D-cn); the shape is frozen. */
export const RoutingTableSchema = z.strictObject({
  v: z.literal(1),
  /** Start tier by the Planner's size, for a task with no risk tag. */
  by_size: z.strictObject({ S: ModelTierSchema, M: ModelTierSchema, L: ModelTierSchema }),
  /** The lowest start tier of a task with any risk tag. */
  tagged_floor: ModelTierSchema,
  /**
   * The lowest start tier of a high-risk task (a tag in `high_risk_tags`, or `risk: high`): the
   * floor under `by_size`, and under a Planner hint too (reading 228).
   */
  high_floor: ModelTierSchema,
  /** Planner risk tags that make a task high risk. */
  high_risk_tags: z.array(SlugSchema).min(1).max(50),
  /**
   * Per-role departures (role id → the cells that differ), where Lookback showed one role needs
   * another start than the shared rule (D-cn). Absent or empty: every routed role follows the
   * shared rule (D-cm).
   */
  roles: z.record(RoleIdSchema, RoutingRoleOverrideSchema).optional(),
});
export type RoutingTable = z.infer<typeof RoutingTableSchema>;

/** VTC's routing table (D-cm). */
export const DEFAULT_ROUTING_TABLE: RoutingTable = RoutingTableSchema.parse({
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
});

/**
 * Pure: the risk class of a task. `risk: high` counts as a high-risk tag (a high-risk task never
 * starts below `high_floor`); `risk: med` alone is not a tag (spine §5 reading 218).
 */
export const taskRiskClass = (
  task: { readonly risk: Risk; readonly risk_tags: readonly string[] },
  table: Pick<RoutingTable, "high_risk_tags"> = DEFAULT_ROUTING_TABLE,
): TaskRiskClass => {
  if (task.risk === "high" || task.risk_tags.some((t) => table.high_risk_tags.includes(t)))
    return "high";
  return task.risk_tags.length > 0 ? "tagged" : "none";
};

/**
 * Pure (D-cm; spine §5 readings 218(2) and 228): the start tier the routing table gives `role` for
 * a task of `size` and risk class `risk`, before any Planner hint, the project's `routing.min_tier`
 * / `max_tier` and QA author's floor. A `roles.<role>` override replaces the shared field it names
 * (`role` undefined: the shared cells). The floors are floors: risk `none` starts on `by_size`,
 * `tagged` on the higher of `by_size` and `tagged_floor`, `high` on the higher of `by_size` and
 * `high_floor`. The one copy of the rule: engine core's router dispatches with it, Lookback
 * measures against it, the compiler renders the Planner's table and the cli shows the table from
 * it. New in 5.5.0.
 */
export const routedStartTier = (
  table: RoutingTable,
  role: string | undefined,
  size: "S" | "M" | "L",
  risk: TaskRiskClass,
): ModelTier => {
  const own = role === undefined ? undefined : table.roles?.[role];
  const bySize = own?.by_size?.[size] ?? table.by_size[size];
  if (risk === "none") return bySize;
  const floor =
    risk === "tagged"
      ? (own?.tagged_floor ?? table.tagged_floor)
      : (own?.high_floor ?? table.high_floor);
  return tierRank(bySize) >= tierRank(floor) ? bySize : floor;
};

/**
 * The fixed metric names of a routing `config` fact (D-cn, subject `routing.<role>.<size>.<risk>`),
 * as Lookback sends them and the upstream module renders them (spine §5 reading 228): the tier
 * ranks ({@link tierRank}) the cell moves from and to and the cell's current start, whether the
 * shared cell (1) or one role's override (0) changes, whether a tier replay was planned, and how
 * many other cells the change lifts with it, each named `routing.lifted.<size>_<risk>` (size in
 * lower case) with its new rank. The scorecard numbers beside them are
 * `routing.<metric>.current` and `.candidate`. Numbers only (D-by). New in 5.5.0.
 */
export const ROUTING_FACT_METRICS = {
  fromTier: "routing.from_tier",
  toTier: "routing.to_tier",
  currentTier: "routing.current_tier",
  shared: "routing.shared",
  replayPlanned: "routing.replay_planned",
  lifted: "routing.lifted",
  liftedPrefix: "routing.lifted.",
} as const;

/** How a project starts per-task roles: by difficulty (the default) or on each role's own tier. */
export const RoutingStartSchema = z.enum(["difficulty", "role"]);
export type RoutingStart = z.infer<typeof RoutingStartSchema>;

/**
 * `project.yaml` `routing` (D-cm). `start: role` turns the rule off (each role's `role.yaml` tier,
 * as before 5.4.0; the calibration's "before" arm). `min_tier` / `max_tier` bound every tier the
 * engine picks for any role run of the project: the rule, a hint, an escalation and a budget drop
 * (QA author keeps its floor). New in 5.4.0.
 */
export const RoutingConfigSchema = z
  .strictObject({
    start: RoutingStartSchema.optional(),
    min_tier: ModelTierSchema.optional(),
    max_tier: ModelTierSchema.optional(),
  })
  .refine(
    (r) =>
      r.min_tier === undefined ||
      r.max_tier === undefined ||
      tierRank(r.min_tier) <= tierRank(r.max_tier),
    { message: "routing.min_tier may not be above routing.max_tier", path: ["min_tier"] },
  );
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;

/** Pure: a project's routing settings with the defaults filled in. */
export const routingFor = (
  config: { readonly routing?: RoutingConfig | undefined } | undefined,
): { readonly start: RoutingStart; readonly min: ModelTier; readonly max: ModelTier } => ({
  start: config?.routing?.start ?? "difficulty",
  min: config?.routing?.min_tier ?? "low",
  max: config?.routing?.max_tier ?? "top",
});

/**
 * D-co's interim rule: a run whose tier resolves to no model id (Codex, until its ids are filled
 * from the official model docs) varies its reasoning effort by tier instead. A role's own higher
 * effort is kept (the engine takes the higher of the two).
 */
export const TIER_EFFORT_WITHOUT_MODEL: Readonly<Record<ModelTier, Effort>> = {
  low: "low",
  mid: "medium",
  top: "high",
};

/**
 * Pure: the `config` improvement subject of a routing-table change Lookback proposes (D-cn),
 * `routing.<role>.<size>.<risk>`, so lookback, engine core and the upstream module name one cell
 * the same way.
 */
export const routingConfigSubject = (
  role: string,
  size: "S" | "M" | "L",
  risk: TaskRiskClass,
): string => `routing.${RoleIdSchema.parse(role)}.${size}.${TaskRiskClassSchema.parse(risk)}`;
