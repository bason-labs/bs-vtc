/**
 * The subject of a D-cd improvement as VTC's repo may read it (D-cs, D-cn; spine §5 readings 219,
 * 221 and 247(8); D-by): `UpstreamReport.subject`, the shared typed `UpstreamSubject`
 * (`UpstreamSubjectSchema`). The allowlist projection (`projectUpstreamReport`) builds it from the
 * subject string the fact named, each kind through its own strict pattern (an allowlist, never a
 * cleaned-up string), and the module renders issue and PR bodies from the report's typed subject
 * only; the rendered title and body still pass the shared redaction and the project-identifier
 * denylist (`assertUpstreamSafe`):
 * - `tool`: a command shape key (`commandShapeKey`: program, subcommand or `-`, flag-set hash),
 *   never an argument value or a path;
 * - `capability`: the missing capability's slug only; its reason text never leaves the project;
 * - `config`: `routing.<role>.<size>.<risk>` (`routingConfigSubject`, D-cn) is a routing-table
 *   cell; any other is one of `UPSTREAM_CONFIG_KEYS`, enumerated, never any dotted key.
 * A subject that does not fit its pattern fails closed with `privacy`. `new_agent` subjects are
 * not rendered (the report's role names the proposal). Under D-cu (reading 241) only a producer's
 * cell can be a routing subject ({@link assertProducerCell}).
 */
import {
  routedByDifficulty,
  upstreamSubjectKey,
  UpstreamSubjectSchema,
  type UpstreamSubject,
} from "@vtc/shared";
import { AutomationSkip } from "./skip.js";

/** A routing-table cell as a typed subject. */
export type RoutingSubject = Extract<UpstreamSubject, { kind: "routing" }>;

const ROUTING = /^routing\.([^.]+)\.([^.]+)\.([^.]+)$/;

const refuse = (kind: string): never => {
  throw new AutomationSkip("privacy", `the ${kind} subject is not in VTC's vocabulary`);
};

/** The typed subject `candidate` parses to, or `null`. */
const typed = (candidate: unknown): UpstreamSubject | null => {
  const parsed = UpstreamSubjectSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
};

/** Pure: a `config` subject that names one routing-table cell (D-cn), or `null`. */
export const routingSubject = (subject: string): RoutingSubject | null => {
  const match = ROUTING.exec(subject.trim());
  if (match === null) return null;
  const cell = typed({ kind: "routing", role: match[1], size: match[2], risk: match[3] });
  return cell?.kind === "routing" ? cell : null;
};

/**
 * Pure: the typed subject of an improvement, `undefined` for a kind whose subject is not
 * rendered. Throws `AutomationSkip("privacy")` for a missing subject or one outside its kind's
 * pattern.
 */
export const projectSubject = (
  kind: string,
  subject: string | undefined,
): UpstreamSubject | undefined => {
  if (kind !== "tool" && kind !== "capability" && kind !== "config") return undefined;
  if (subject === undefined) return refuse(kind);
  const text = subject.trim();
  switch (kind) {
    case "tool": {
      const [program, sub, flags, ...rest] = text.split(" ");
      if (rest.length > 0) return refuse(kind);
      const shape = { program, ...(sub === "-" ? {} : { subcommand: sub }), flags };
      return typed({ kind: "tool", shape }) ?? refuse(kind);
    }
    case "capability":
      return typed({ kind: "capability", slug: text }) ?? refuse(kind);
    case "config":
      if (text.startsWith("routing.")) return routingSubject(text) ?? refuse(kind);
      return typed({ kind: "config", key: text }) ?? refuse(kind);
  }
};

/**
 * Pure (D-cu; spine §5 reading 241): whether a routing cell is a producer's, whose start the
 * routing table sets (`routedByDifficulty`): the Engineer family, or QA, whose author mode is
 * routed and whose modes share the role's one cell.
 */
export const isProducerCell = (cell: RoutingSubject): boolean =>
  routedByDifficulty(cell.role, cell.role === "qa" ? "author" : undefined);

/**
 * Throws `AutomationSkip("out_of_scope")` for a routing cell that is not a producer's (D-cu): a
 * reviewer or a task-less role starts on its own `role.yaml` tier, so no routing-table change can
 * move it, and its issue or PR would ask for an edit that does nothing.
 */
export const assertProducerCell = (cell: RoutingSubject): void => {
  if (!isProducerCell(cell))
    throw new AutomationSkip(
      "out_of_scope",
      `${upstreamSubjectKey(cell)} is not a producer's cell: under D-cu only the Engineer family and QA author start on the routing table`,
    );
};

/** The file and constant a routing-table PR may change (D-cn; spine §5 reading 219). */
export const ROUTING_TABLE_FILE = "packages/shared/src/tier-routing.ts";
export const ROUTING_TABLE_CONSTANT = "DEFAULT_ROUTING_TABLE";

/** The line of a routing issue that names its cell; read back when its run's PR opens. */
const ROUTING_LINE = /^Routing cell: `(routing\.[^`]+)`$/m;

/** Pure: the line naming a routing issue's cell (parsed back by {@link routingSubjectOfBody}). */
export const routingCellLine = (subject: RoutingSubject): string =>
  `Routing cell: \`${upstreamSubjectKey(subject)}\``;

/**
 * Pure: the routing cell an issue body names (the line {@link routingCellLine} wrote), checked
 * again as a routing subject; `null` for any other body.
 */
export const routingSubjectOfBody = (body: string | undefined): RoutingSubject | null => {
  const match = ROUTING_LINE.exec(body ?? "");
  return match?.[1] === undefined ? null : routingSubject(match[1]);
};

/**
 * Pure: what a routing-table change keeps to (D-cn): only the values of
 * {@link ROUTING_TABLE_CONSTANT} in {@link ROUTING_TABLE_FILE}, the shared cell or the role's
 * `roles.<role>` cells; no schema change and no `CONTRACTS_VERSION` bump. The upstream module
 * makes that edit itself (`buildRoutingPr`, spine §5 reading 233); no automatic run answers the
 * issue, so nothing a run's flow requires (acceptance tests, a CHANGELOG entry) can ride along.
 */
export const routingChangeRule = (subject: RoutingSubject): string =>
  [
    `Change only the values of \`${ROUTING_TABLE_CONSTANT}\` in \`${ROUTING_TABLE_FILE}\`: the shared cell for size ${subject.size} with risk class \`${subject.risk}\`, or, when only \`${subject.role}\` differs, its cells under \`roles.${subject.role}\`.`,
    "Do not change the schema, any other file or `CONTRACTS_VERSION`; the routing scorecard charts are the evidence and the human merges it.",
    "VTC opens this PR itself, with no run.",
  ].join(" ");
