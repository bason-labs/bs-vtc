/**
 * The routing table as the Planner's prompt shows it (H-9, D-cm; spine §5 reading 218). The engine
 * picks each task's start tier from its size and risk (`RoutingTable`, `DEFAULT_ROUTING_TABLE`
 * in @vtc/shared); the Planner only needs to know what the table says, so it can tell when the
 * table clearly misjudges a task and set a reason-coded `tier_hint`. Everything here is rendered
 * from the frozen table and enums, so a reviewed change to the table's values (D-cn) reaches the
 * prompt at the next compile with no hand edit.
 */
import {
  TaskRiskClassSchema,
  tierRank,
  TierHintReasonSchema,
  type ModelTier,
  type RoutingTable,
  type TaskRiskClass,
  type TierHintReason,
} from "@vtc/shared";

const SIZES = ["S", "M", "L"] as const;

const higher = (a: ModelTier, b: ModelTier): ModelTier => (tierRank(a) >= tierRank(b) ? a : b);

/**
 * Pure: the start tier the table gives a task of `size` and risk class `risk`, before any hint
 * or project clamp: the size's tier, raised to `tagged_floor` for any risk tag and to
 * `high_floor` for a high-risk one (the floors are lower bounds, as their names say, and reading
 * 218 (2): a high-risk task never starts below Top).
 *
 * A second copy of engine core's rule (`core/routing.ts`), used only to render the Planner's
 * table, so it is not exported from the package. It goes once `@vtc/shared` has a pure
 * `startTierFor(table, size, riskClass)` that engine core and the compiler both call (a contract
 * proposal of this branch).
 */
export const routingStartTier = (
  table: RoutingTable,
  size: (typeof SIZES)[number],
  risk: TaskRiskClass,
): ModelTier => {
  const bySize = table.by_size[size];
  if (risk === "high") return higher(bySize, table.high_floor);
  if (risk === "tagged") return higher(bySize, table.tagged_floor);
  return bySize;
};

const code = (text: string): string => `\`${text}\``;

/** The high-risk tags as the prompt names them. */
export const renderHighRiskTags = (table: RoutingTable): string =>
  table.high_risk_tags.map(code).join(", ");

const COLUMN_TITLES: Readonly<Record<TaskRiskClass, string>> = {
  none: "no risk tag",
  tagged: "any risk tag",
  high: "high-risk tag or `risk: high`",
};

/**
 * Pure: the table as Markdown, one row per size and one column per risk class, then the
 * high-risk tags, and the roles a reviewed change gave cells of their own (D-cn), if any.
 */
export const renderRoutingTable = (table: RoutingTable): string => {
  const classes = TaskRiskClassSchema.options;
  const lines = [
    `| size | ${classes.map((c) => COLUMN_TITLES[c]).join(" | ")} |`,
    `|---|${classes.map(() => "---").join("|")}|`,
    ...SIZES.map(
      (size) =>
        `| ${size} | ${classes.map((c) => code(routingStartTier(table, size, c))).join(" | ")} |`,
    ),
    "",
    `High-risk tags: ${renderHighRiskTags(table)}. \`risk: high\` counts as a high-risk tag.`,
  ];
  const roles = Object.keys(table.roles ?? {}).sort();
  if (roles.length > 0) {
    lines.push(
      `Roles that start differently in some cells (the engine applies them): ${roles.map(code).join(", ")}.`,
    );
  }
  return lines.join("\n");
};

/**
 * Which way each `TierHintReason` moves the start tier, as the schema's doc groups them. A
 * `Record` over the enum, so a new reason fails the typecheck until it is placed here.
 */
export const TIER_HINT_REASON_DIRECTION: Readonly<Record<TierHintReason, "raise" | "lower">> = {
  cross_cutting: "raise",
  novel_logic: "raise",
  concurrency: "raise",
  subtle_invariants: "raise",
  large_context: "raise",
  unfamiliar_stack: "raise",
  mechanical: "lower",
  boilerplate: "lower",
  docs_or_config: "lower",
  well_specified: "lower",
};

/** The reason codes that move the tier one way, in the schema's order. */
export const tierHintReasons = (direction: "raise" | "lower"): string =>
  TierHintReasonSchema.options
    .filter((reason) => TIER_HINT_REASON_DIRECTION[reason] === direction)
    .map(code)
    .join(", ");
