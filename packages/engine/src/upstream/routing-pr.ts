/**
 * The routing-table PR (D-cn; spine §5 readings 219 and 233). Lookback's routing proposal reaches
 * VTC's repo as a `config` issue naming one routing cell and the tier it moves to; the upstream
 * module answers it with a PR it makes itself, as it does a Lookback prompt PR: a value-only edit
 * of `DEFAULT_ROUTING_TABLE` in `packages/shared/src/tier-routing.ts`, read at the PR's base and
 * written back in the file's own form. No automatic run makes it, so no QA author tests, CHANGELOG
 * entry or test edit rides along, and the PR changes that one file. The human merges it.
 *
 * Every step fails closed: a file not in the form below, a cell the table no longer starts on the
 * move's `from` tier (`stale_baseline`), or a move one value of the table cannot make
 * (`out_of_scope`) opens nothing.
 */
import {
  ModelTierSchema,
  ROUTING_FACT_METRICS,
  ROUTING_REPLAY_VERDICT_CODES,
  ReplayVerdictSchema,
  RoutingTableSchema,
  routedStartTier,
  routingReplayBacks,
  tierRank,
  TIER_ORDER,
  upstreamSubjectKey,
  type ModelTier,
  type ReplayVerdict,
  type RoutingRoleOverride,
  type RoutingTable,
} from "@vtc/shared";
import { AutomationSkip } from "./skip.js";
import { ROUTING_TABLE_CONSTANT, ROUTING_TABLE_FILE, type RoutingSubject } from "./subject.js";

/** The tier a routing cell moves from and to, and whether the shared cell or one role's moves. */
export interface RoutingMove {
  readonly from: ModelTier;
  readonly to: ModelTier;
  readonly scope: "shared" | "role";
}

const tierAt = (rank: number | undefined): ModelTier | undefined =>
  rank === undefined || !Number.isInteger(rank) ? undefined : TIER_ORDER[rank];

/** Pure: the move a routing fact's metrics name (`ROUTING_FACT_METRICS`), or `null`. */
export const routingMoveOfMetrics = (
  metrics: Readonly<Record<string, number>> | undefined,
): RoutingMove | null => {
  const from = tierAt(metrics?.[ROUTING_FACT_METRICS.fromTier]);
  const to = tierAt(metrics?.[ROUTING_FACT_METRICS.toTier]);
  const shared = metrics?.[ROUTING_FACT_METRICS.shared];
  if (from === undefined || to === undefined || from === to) return null;
  if (shared !== 0 && shared !== 1) return null;
  return { from, to, scope: shared === 1 ? "shared" : "role" };
};

/**
 * The graded tier replay that backs a routing change (D-cn; spine §5 reading 247(6)): its verdict
 * (arm `b`, the proposed tier, against arm `a`, the current one) and how many trials it graded.
 * Numbers only reach VTC's repo; the `RoutingReplayResult` file stays on the machine that graded it.
 */
export interface RoutingReplay {
  readonly verdict: ReplayVerdict;
  readonly trials: number;
}

const VERDICT_OF_CODE: ReadonlyMap<number, ReplayVerdict> = new Map(
  Object.entries(ROUTING_REPLAY_VERDICT_CODES).map(([verdict, code]) => [
    code,
    ReplayVerdictSchema.parse(verdict),
  ]),
);

/**
 * Pure: the graded tier replay a routing fact's metrics carry (`routing.replay_verdict`, decoded
 * with `ROUTING_REPLAY_VERDICT_CODES`, and `routing.replay_trials`), or `null` unless both are
 * there and valid: the fact then carries the scorecard alone.
 */
export const routingReplayOfMetrics = (
  metrics: Readonly<Record<string, number>> | undefined,
): RoutingReplay | null => {
  const code = metrics?.[ROUTING_FACT_METRICS.replayVerdict];
  const trials = metrics?.[ROUTING_FACT_METRICS.replayTrials];
  const verdict = code === undefined ? undefined : VERDICT_OF_CODE.get(code);
  if (verdict === undefined || trials === undefined) return null;
  return Number.isInteger(trials) && trials > 0 ? { verdict, trials } : null;
};

/** Pure: whether `replay` backs `move` (`routingReplayBacks`: cheaper holds, higher improves). */
const backs = (replay: RoutingReplay, move: Pick<RoutingMove, "from" | "to">): boolean =>
  routingReplayBacks(
    tierRank(move.to) > tierRank(move.from) ? "higher" : "cheaper",
    replay.verdict,
  );

const REPLAY_LINE =
  /^A graded tier replay (?:backs|does not back) the move: verdict `(regress|no_change|improve|inconclusive)` over ([1-9][0-9]{0,8}) trials\.$/m;

/** Pure: the routing issue's line citing the graded replay ({@link routingReplayOfBody} reads it). */
export const routingReplayLine = (
  replay: RoutingReplay,
  move: Pick<RoutingMove, "from" | "to">,
): string =>
  `A graded tier replay ${backs(replay, move) ? "backs" : "does not back"} the move: verdict \`${replay.verdict}\` over ${String(replay.trials)} trials.`;

/**
 * Pure: the graded replay a routing issue's body cites (the line {@link routingReplayLine} wrote),
 * or `null`. Like the move, it is read from the body as listed when another installation raised
 * the issue; the PR only ever cites it, and the human reviews the PR.
 */
export const routingReplayOfBody = (body: string | undefined): RoutingReplay | null => {
  const match = REPLAY_LINE.exec(body ?? "");
  if (match === null) return null;
  return { verdict: ReplayVerdictSchema.parse(match[1]), trials: Number(match[2]) };
};

const MOVE_LINE =
  /^Move the start tier from `(low|mid|top)` to `(low|mid|top)` in (?:the shared cell|`roles\.([^`]+)`'s cell only)\./m;

/**
 * Pure: the move a routing issue's body names (the line `upstreamIssueSlots` renders from the same
 * metrics), for the subject's own role only; `null` for any other body. The body is as listed,
 * which anyone may edit: it only ever picks one of the three tiers for the issue's own cell, and
 * the PR it leads to is a draft the human reviews.
 */
export const routingMoveOfBody = (
  body: string | undefined,
  subject: RoutingSubject,
): RoutingMove | null => {
  const match = MOVE_LINE.exec(body ?? "");
  if (match === null) return null;
  const from = ModelTierSchema.parse(match[1]);
  const to = ModelTierSchema.parse(match[2]);
  const role = match[3];
  if (from === to || (role !== undefined && role !== subject.role)) return null;
  return { from, to, scope: role === undefined ? "shared" : "role" };
};

/** The field of the table a cell's risk class reads beside `by_size`. */
const floorField = (risk: RoutingSubject["risk"]): "tagged_floor" | "high_floor" =>
  risk === "tagged" ? "tagged_floor" : "high_floor";

/**
 * Pure: `table` with `subject`'s cell moved: risk `none` sets `by_size.<size>`, `tagged` sets
 * `tagged_floor`, `high` sets `high_floor` (Lookback's `tableField`), in the shared cells or under
 * `roles.<role>`. Throws `stale_baseline` when the table does not start the cell on `move.from`
 * now, and `out_of_scope` when the edit does not start it on `move.to` (a floor under a higher
 * `by_size`).
 */
export const applyRoutingMove = (
  table: RoutingTable,
  subject: RoutingSubject,
  move: RoutingMove,
): RoutingTable => {
  const role = move.scope === "role" ? subject.role : undefined;
  const now = routedStartTier(table, role, subject.size, subject.risk);
  if (now !== move.from)
    throw new AutomationSkip(
      "stale_baseline",
      `the routing table starts ${upstreamSubjectKey(subject)} on ${now} now, not on ${move.from} as Lookback measured`,
    );
  let next: RoutingTable;
  if (move.scope === "shared") {
    next =
      subject.risk === "none"
        ? { ...table, by_size: { ...table.by_size, [subject.size]: move.to } }
        : { ...table, [floorField(subject.risk)]: move.to };
  } else {
    const own: RoutingRoleOverride = table.roles?.[subject.role] ?? {};
    const changed: RoutingRoleOverride =
      subject.risk === "none"
        ? { ...own, by_size: { ...own.by_size, [subject.size]: move.to } }
        : { ...own, [floorField(subject.risk)]: move.to };
    next = { ...table, roles: { ...table.roles, [subject.role]: changed } };
  }
  const parsed = RoutingTableSchema.parse(next);
  const moved = routedStartTier(parsed, role, subject.size, subject.risk);
  if (moved !== move.to)
    throw new AutomationSkip(
      "out_of_scope",
      `one value of the routing table cannot start ${upstreamSubjectKey(subject)} on ${move.to} (it would start on ${moved})`,
    );
  return parsed;
};

const DECLARATION = `export const ${ROUTING_TABLE_CONSTANT}: RoutingTable = RoutingTableSchema.parse(`;
const LITERAL_END = "\n});";
const PRINT_WIDTH = 100;

/** Where the table's object literal sits in the file: `{` up to the `}` of the closing `});`. */
const literalSpan = (source: string): { readonly start: number; readonly end: number } => {
  const at = source.indexOf(DECLARATION);
  if (at < 0) throw new Error(`${ROUTING_TABLE_FILE} declares no ${ROUTING_TABLE_CONSTANT}`);
  if (source.indexOf(DECLARATION, at + 1) >= 0)
    throw new Error(`${ROUTING_TABLE_FILE} must declare ${ROUTING_TABLE_CONSTANT} once`);
  const start = at + DECLARATION.length;
  const close = source.indexOf(LITERAL_END, start);
  if (source[start] !== "{" || close < 0)
    throw new Error(`${ROUTING_TABLE_CONSTANT} is not the object literal VTC edits`);
  return { start, end: close + 2 };
};

/**
 * Pure: the routing table `source` (the text of {@link ROUTING_TABLE_FILE}) declares, read as
 * data: the literal's bare keys quoted and trailing commas dropped, then JSON and the strict
 * schema. A comment, an expression or anything else outside that form throws.
 */
export const readRoutingTableSource = (source: string): RoutingTable => {
  const { start, end } = literalSpan(source);
  const literal = source.slice(start, end);
  if (/\/\/|\/\*/.test(literal)) throw new Error(`${ROUTING_TABLE_CONSTANT} holds a comment`);
  const json = literal
    .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
    .replace(/,(\s*[}\]])/g, "$1");
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new Error(`${ROUTING_TABLE_CONSTANT} is not the plain object literal VTC edits`);
  }
  return RoutingTableSchema.parse(data);
};

const key = (name: string): string => (/^[A-Za-z_$][\w$]*$/.test(name) ? name : `"${name}"`);
const str = (value: string): string => JSON.stringify(value);

/** `{ a: x, b: y }` when it fits after `prefix`, else one entry a line (Prettier's own layout). */
const objectAt = (indent: string, prefix: string, entries: readonly string[], end: string) => {
  const inline = `${indent}${prefix}{ ${entries.join(", ")} }${end}`;
  if (inline.length <= PRINT_WIDTH) return [inline];
  return [`${indent}${prefix}{`, ...entries.map((e) => `${indent}  ${e},`), `${indent}}${end}`];
};

const bySize = (cells: Partial<Record<"S" | "M" | "L", ModelTier>>): string[] =>
  (["S", "M", "L"] as const).flatMap((s) => {
    const tier = cells[s];
    return tier === undefined ? [] : [`${s}: ${str(tier)}`];
  });

/**
 * Pure: the table's object literal as the file holds it and as Prettier (print width 100) leaves
 * it: one top-level field a line, `roles` one role a line (expanded when it does not fit).
 */
export const renderRoutingTableLiteral = (table: RoutingTable): string => {
  const t = RoutingTableSchema.parse(table);
  const tags = t.high_risk_tags.map(str);
  const tagLine = `  high_risk_tags: [${tags.join(", ")}],`;
  const lines = [
    "{",
    `  v: ${String(t.v)},`,
    `  by_size: { ${bySize(t.by_size).join(", ")} },`,
    `  tagged_floor: ${str(t.tagged_floor)},`,
    `  high_floor: ${str(t.high_floor)},`,
    ...(tagLine.length <= PRINT_WIDTH
      ? [tagLine]
      : ["  high_risk_tags: [", ...tags.map((tag) => `    ${tag},`), "  ],"]),
  ];
  const roles = Object.entries(t.roles ?? {});
  if (roles.length > 0) {
    lines.push("  roles: {");
    for (const [role, own] of roles) {
      const entries = [
        ...(own.by_size === undefined ? [] : [`by_size: { ${bySize(own.by_size).join(", ")} }`]),
        ...(own.tagged_floor === undefined ? [] : [`tagged_floor: ${str(own.tagged_floor)}`]),
        ...(own.high_floor === undefined ? [] : [`high_floor: ${str(own.high_floor)}`]),
      ];
      lines.push(
        ...(entries.length === 0
          ? [`    ${key(role)}: {},`]
          : objectAt("    ", `${key(role)}: `, entries, ",")),
      );
    }
    lines.push("  },");
  }
  lines.push("}");
  return lines.join("\n");
};

/** Pure: `source` with its table's literal replaced by `table`'s ({@link renderRoutingTableLiteral}). */
export const writeRoutingTableSource = (source: string, table: RoutingTable): string => {
  const { start, end } = literalSpan(source);
  return `${source.slice(0, start)}${renderRoutingTableLiteral(table)}${source.slice(end)}`;
};

/** The field a move sets, as the PR names it. */
const fieldName = (subject: RoutingSubject, move: RoutingMove): string => {
  const field = subject.risk === "none" ? `by_size.${subject.size}` : floorField(subject.risk);
  return move.scope === "shared" ? field : `roles.${subject.role}.${field}`;
};

const RISK_TEXT: Readonly<Record<RoutingSubject["risk"], string>> = {
  none: "no risk tag",
  tagged: "a risk tag",
  high: "high risk",
};

/**
 * Pure: what the PR says of the graded tier replay (reading 247(6)): its verdict and trial count
 * when the fact carries one (the result file stays local), else that the scorecard is the only
 * evidence.
 */
const replayText = (replay: RoutingReplay | null, move: RoutingMove): string => {
  if (replay === null)
    return "No tier replay backs this change, so the routing scorecard is the only evidence.";
  const cited = `verdict \`${replay.verdict}\` over ${String(replay.trials)} trials (Lookback ran the cell's recorded tasks on both tiers and graded them; the replay result stays on the machine that ran it)`;
  return backs(replay, move)
    ? `A graded tier replay backs this change: ${cited}. The routing scorecard charts below are the rest of the evidence.`
    : `A graded tier replay does not back this change: ${cited}. Check the routing scorecard charts below before merging.`;
};

export interface RoutingPrParts {
  /** The new text of {@link ROUTING_TABLE_FILE}. */
  readonly text: string;
  readonly summary: string;
  readonly slots: Readonly<Record<string, string>>;
}

/**
 * Pure: the routing PR for `subject` and `move` over `source` (the table file at the PR's base):
 * the file's new text, the PR's one-line summary and its body slots, in VTC's vocabulary only.
 */
export const buildRoutingPr = (input: {
  readonly subject: RoutingSubject;
  readonly move: RoutingMove;
  readonly source: string;
  readonly vtcVersion: string;
  readonly issue?: number | undefined;
  /** The graded tier replay the routing fact carries (reading 247(6)); absent: the scorecard alone. */
  readonly replay?: RoutingReplay | null | undefined;
}): RoutingPrParts => {
  const { subject, move } = input;
  const replay = input.replay ?? null;
  const key = upstreamSubjectKey(subject);
  const table = readRoutingTableSource(input.source);
  const next = applyRoutingMove(table, subject, move);
  const text = writeRoutingTableSource(input.source, next);
  if (text === input.source) throw new Error("the routing move changes nothing");
  const field = fieldName(subject, move);
  const who = move.scope === "shared" ? "every routed role" : `\`${subject.role}\` only`;
  const diff = ["```diff", `- ${field}: "${move.from}"`, `+ ${field}: "${move.to}"`, "```"].join(
    "\n",
  );
  return {
    text,
    summary: `start ${subject.role} ${subject.size} tasks with ${RISK_TEXT[subject.risk]} on ${move.to}`,
    slots: {
      summary: `Lookback's routing scorecard${replay !== null && backs(replay, move) ? " and a graded tier replay back" : " backs"} starting ${subject.size} tasks with ${RISK_TEXT[subject.risk]} on \`${move.to}\` instead of \`${move.from}\` for ${who}${input.issue === undefined ? "" : ` (#${String(input.issue)})`}.`,
      why: `Routing cell \`${key}\`. The routing scorecard charts below are the evidence (quality per token, the escalation share and the cost per task of each start tier).`,
      changes: `- \`${ROUTING_TABLE_FILE}\`: the value of \`${ROUTING_TABLE_CONSTANT}.${field}\` only; no schema change and no \`CONTRACTS_VERSION\` bump`,
      diff,
      verification: [
        "VTC made this edit itself from the routing fact (no run): it read the table at the base commit, checked the cell still starts on the tier Lookback measured, and checked the edited table starts it on the new tier.",
        replayText(replay, move),
      ].join("\n\n"),
      risk: "A value-only change of the routing table: the next runs start this cell on another tier. Revert this PR to roll back; Lookback's routing scorecard keeps measuring the cell.",
      provenance: [
        "<details><summary>Provenance</summary>",
        "",
        `- routing cell: \`${key}\`, ${move.scope === "shared" ? "shared cell" : `\`roles.${subject.role}\``}`,
        `- VTC ${input.vtcVersion}; generated by VTC (AI); human review required.`,
        "",
        "</details>",
      ].join("\n"),
      checklist: [
        "- [ ] Check the routing scorecard charts for the cell",
        `- [ ] The diff changes one value of \`${ROUTING_TABLE_CONSTANT}\` only`,
        "- [ ] The cost and escalation numbers justify the new start tier",
      ].join("\n"),
    },
  };
};
