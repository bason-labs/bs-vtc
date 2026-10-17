/**
 * The routing table as the Planner's prompt shows it (H-9, D-cm; spine §5 reading 218). The engine
 * picks each task's start tier from its size and risk (`RoutingTable`, `DEFAULT_ROUTING_TABLE`
 * in @vtc/shared); the Planner only needs to know what the table says, so it can tell when the
 * table clearly misjudges a task and set a reason-coded `tier_hint`. Everything here is rendered
 * from the frozen table and enums, so a reviewed change to the table's values (D-cn) reaches the
 * prompt at the next compile with no hand edit. Since contracts 5.7.0 (D-cu, D-cv; readings 241
 * and 242) it also says who the table starts (the producers only) and how each start escalates,
 * asked of `routedByDifficulty`, `reviewerStartTier` and `escalationSteps`.
 */
import {
  escalationSteps,
  reviewerStartTier,
  routedByDifficulty,
  routedStartTier,
  TaskRiskClassSchema,
  TIER_ORDER,
  TierHintReasonSchema,
  tierRank,
  type ModelTier,
  type RoutingTable,
  type TaskRiskClass,
  type TierHintReason,
} from "@vtc/shared";

const SIZES = ["S", "M", "L"] as const;

/**
 * Pure: the start tier the table gives a task of `size` and risk class `risk`, before any hint
 * or project clamp: the shared cells of `routedStartTier` (contracts 5.5.0), the one rule engine
 * core's router dispatches with, so the Planner's table is the engine's.
 */
export const routingStartTier = (
  table: RoutingTable,
  size: (typeof SIZES)[number],
  risk: TaskRiskClass,
): ModelTier => routedStartTier(table, undefined, size, risk);

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

/**
 * One kind of per-task run the Planner's start-tier text names, as engine core dispatches it
 * (spec §6.3 steps 5–7, §12.4): the role, its mode and whether it fills the cross-family reviewer
 * slot (a QA judge on the other host family). Which group a run is in (routed by the table, on its
 * own tier, raised on a risky task) is never written here: {@link renderStartRoles} asks the
 * shared rules.
 */
export interface TaskRun {
  readonly name: string;
  readonly role: string;
  readonly mode?: string;
  readonly crossFamily?: true;
}

/** The per-task runs, producers first, in the order the prompt names them. */
export const TASK_RUNS: readonly TaskRun[] = [
  { name: "the Engineer and its discipline profiles", role: "engineer" },
  { name: "QA writing the acceptance tests", role: "qa", mode: "author" },
  { name: "the Spec Verifier", role: "spec_verifier" },
  { name: "the QA judge", role: "qa", mode: "judge" },
  { name: "Security verify", role: "security", mode: "verify" },
  { name: "Visual QA", role: "visual_qa" },
  { name: "the lens reviewers", role: "lens_auth" },
  { name: "the cross-family reviewer", role: "qa", mode: "judge", crossFamily: true },
];

/** The shared start rules (contracts 5.7.0, D-cu); a parameter so the tests can vary them. */
export interface StartRules {
  readonly routedByDifficulty: typeof routedByDifficulty;
  readonly reviewerStartTier: typeof reviewerStartTier;
}

const SHARED_START_RULES: StartRules = { routedByDifficulty, reviewerStartTier };

const RISK_PHRASES: Readonly<Record<TaskRiskClass, string>> = {
  none: "no risk tag",
  tagged: "any risk tag",
  high: "a high-risk tag or `risk: high`",
};

const TIER_COUNTS: readonly string[] = ["", "one tier", "two tiers"];

/** `a`, `a and b`, `a, b and c`; with a comma before the last `and` when an item has one. */
const joinAnd = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")}${items.some((i) => i.includes(" and ")) ? "," : ""} and ${items[items.length - 1] ?? ""}`;

/**
 * Pure (D-cu; spine §5 reading 241): who the routing table starts, as the Planner's prompt says
 * it: the runs `routedByDifficulty` routes (the producers), the reviewers on their own tier, and
 * the reviewers `reviewerStartTier` raises, with how far and on which risk classes. Every group
 * is asked of the shared rules, probed from the lowest tier, so a change to either rule reaches
 * the prompt at the next compile with no hand edit.
 */
export const renderStartRoles = (rules: StartRules = SHARED_START_RULES): string => {
  const routed = (run: TaskRun): boolean => rules.routedByDifficulty(run.role, run.mode);
  const producers = TASK_RUNS.filter(routed).map((r) => r.name);
  const reviewers = TASK_RUNS.filter((r) => !routed(r));
  const lowest = TIER_ORDER[0] ?? "low";
  const top = TIER_ORDER[TIER_ORDER.length - 1] ?? "top";
  // reviewers raised alike (by the same number of tiers on the same risk classes) share a clause
  const raises = new Map<string, { by: number; classes: TaskRiskClass[]; names: string[] }>();
  for (const run of reviewers) {
    const raised = TaskRiskClassSchema.options.flatMap((risk) => {
      const start = rules.reviewerStartTier({
        role: run.role,
        mode: run.mode,
        roleTier: lowest,
        risk,
        crossFamily: run.crossFamily,
      });
      return start.reason === "rule" ? [{ risk, by: tierRank(start.tier) - tierRank(lowest) }] : [];
    });
    if (raised.length === 0) continue;
    const by = Math.max(...raised.map((r) => r.by));
    const classes = raised.map((r) => r.risk);
    const key = `${String(by)}|${classes.join(",")}`;
    const group = raises.get(key) ?? { by, classes, names: [] };
    raises.set(key, { ...group, names: [...group.names, run.name] });
  }
  const sentences = [`The table sets the start tier of the producers only: ${joinAnd(producers)}.`];
  if (reviewers.length > 0) {
    const exceptions = [...raises.values()].map(({ by, classes, names }) => {
      const where =
        classes.length === 1 && classes[0] === "high"
          ? `a high-risk task (${RISK_PHRASES.high})`
          : `a task with ${classes.map((c) => RISK_PHRASES[c]).join(" or ")}`;
      const tiers = TIER_COUNTS[by] ?? `${String(by)} tiers`;
      return `${joinAnd(names)} ${names.length === 1 ? "starts" : "start"} ${tiers} above it on ${where}, at most \`${top}\``;
    });
    sentences.push(
      `The reviewers (${joinAnd(reviewers.map((r) => r.name))}) start on their own role tier, whatever the table says${
        exceptions.length === 0 ? "." : `, except that ${exceptions.join("; and ")}.`
      }`,
    );
  }
  return sentences.join(" ");
};

const tierRounds = (tier: ModelTier, from: number, to: number | undefined): string =>
  to === undefined
    ? `\`${tier}\` from round ${String(from)}`
    : from === to
      ? `\`${tier}\` in round ${String(from)}`
      : `\`${tier}\` in rounds ${String(from)}–${String(to)}`;

/**
 * Pure (D-cv; spine §5 reading 242): the tier each start runs on round by round, as
 * `escalationSteps` gives it, until it reaches the top tier ("a low start runs low in round 1, mid
 * in round 2 and top from round 3; ..."). The round cap is the task's own.
 */
export const renderTierEscalation = (steps: typeof escalationSteps = escalationSteps): string => {
  const top = TIER_ORDER.length - 1;
  const MAX_ROUNDS = 20;
  return TIER_ORDER.map((start) => {
    const at = (round: number): number => Math.min(top, tierRank(start) + steps(start, round));
    if (at(MAX_ROUNDS) === tierRank(start)) return `a \`${start}\` start stays on \`${start}\``;
    const spans: string[] = [];
    let from = 1;
    for (let round = 1; round <= MAX_ROUNDS; round += 1) {
      const tier = TIER_ORDER[at(round)] ?? start;
      if (at(round) === top) {
        spans.push(tierRounds(tier, round, undefined));
        break;
      }
      if (at(round + 1) !== at(round)) {
        spans.push(tierRounds(tier, from, round));
        from = round + 1;
      }
    }
    return `a \`${start}\` start runs ${joinAnd(spans)}`;
  }).join("; ");
};
