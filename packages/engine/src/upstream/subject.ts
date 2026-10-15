/**
 * The subject of a D-cd improvement as VTC's repo may read it (D-cs, D-cn; spine §5 readings 219
 * and 221; D-by). The fingerprint names the subject; the issue says what it is, but only in VTC's
 * own vocabulary, each kind through its own strict pattern (an allowlist, never a cleaned-up
 * string), and the rendered title and body still pass the shared redaction and the
 * project-identifier denylist (`assertUpstreamSafe`):
 * - `tool`: a command shape key (`commandShapeKey`: program, subcommand or `-`, flag-set hash),
 *   never an argument value or a path;
 * - `capability`: the missing capability's slug only; its reason text never leaves the project;
 * - `config`: `routing.<role>.<size>.<risk>` (`routingConfigSubject`, D-cn) is a routing-table
 *   change; any other is a cap or budget key such as `budget.task_s` or `caps.fix_rounds`.
 * A subject that does not fit its pattern fails closed with `privacy`. `new_agent` subjects are
 * not rendered (the report's role names the proposal).
 */
import {
  CommandShapeSchema,
  RoleIdSchema,
  SlugSchema,
  TaskRiskClassSchema,
  type CommandShape,
  type TaskRiskClass,
} from "@vtc/shared";
import { AutomationSkip } from "./skip.js";

export type UpstreamSubject =
  | { readonly kind: "tool"; readonly key: string; readonly shape: CommandShape }
  | { readonly kind: "capability"; readonly slug: string }
  | {
      readonly kind: "routing";
      readonly key: string;
      readonly role: string;
      readonly size: "S" | "M" | "L";
      readonly risk: TaskRiskClass;
    }
  | { readonly kind: "config"; readonly key: string };

const ROUTING = /^routing\.([^.]+)\.(S|M|L)\.([a-z]+)$/;
const CONFIG_KEY = /^[a-z][a-z0-9_]{0,39}(?:\.[a-z0-9_]{1,40}){0,3}$/;

const refuse = (kind: string): never => {
  throw new AutomationSkip("privacy", `the ${kind} subject is not in VTC's vocabulary`);
};

/** Pure: a `config` subject that names one routing-table cell (D-cn), or `null`. */
export const routingSubject = (
  subject: string,
): Extract<UpstreamSubject, { kind: "routing" }> | null => {
  const match = ROUTING.exec(subject.trim());
  if (match === null) return null;
  const role = RoleIdSchema.safeParse(match[1]);
  const risk = TaskRiskClassSchema.safeParse(match[3]);
  if (!role.success || !risk.success) return null;
  const size = match[2] as "S" | "M" | "L";
  return {
    kind: "routing",
    key: `routing.${role.data}.${size}.${risk.data}`,
    role: role.data,
    size,
    risk: risk.data,
  };
};

/**
 * Pure: the projected subject of an improvement, `undefined` for a kind whose subject is not
 * rendered. Throws `AutomationSkip("privacy")` for a subject outside its kind's pattern.
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
      const shape = CommandShapeSchema.safeParse({
        program,
        ...(sub === "-" ? {} : { subcommand: sub }),
        flags,
      });
      if (rest.length > 0 || !shape.success) return refuse(kind);
      return { kind: "tool", key: text, shape: shape.data };
    }
    case "capability": {
      const slug = SlugSchema.safeParse(text);
      return slug.success ? { kind: "capability", slug: slug.data } : refuse(kind);
    }
    case "config": {
      if (text.startsWith("routing.")) return routingSubject(text) ?? refuse(kind);
      return CONFIG_KEY.test(text) ? { kind: "config", key: text } : refuse(kind);
    }
  }
};

/** The file and constant a routing-table PR may change (D-cn; spine §5 reading 219). */
export const ROUTING_TABLE_FILE = "packages/shared/src/tier-routing.ts";
export const ROUTING_TABLE_CONSTANT = "DEFAULT_ROUTING_TABLE";

/** The line of a routing issue that names its cell; read back when its run's PR opens. */
const ROUTING_LINE = /^Routing cell: `(routing\.[^`]+)`$/m;

/** Pure: the line naming a routing issue's cell (parsed back by {@link routingSubjectOfBody}). */
export const routingCellLine = (subject: Extract<UpstreamSubject, { kind: "routing" }>): string =>
  `Routing cell: \`${subject.key}\``;

/**
 * Pure: the routing cell an issue body names (the line {@link routingCellLine} wrote), checked
 * again as a routing subject; `null` for any other body.
 */
export const routingSubjectOfBody = (
  body: string | undefined,
): Extract<UpstreamSubject, { kind: "routing" }> | null => {
  const match = ROUTING_LINE.exec(body ?? "");
  return match?.[1] === undefined ? null : routingSubject(match[1]);
};

/**
 * Pure: what an automatic run must keep to for a routing-table change (D-cn): only the values of
 * {@link ROUTING_TABLE_CONSTANT} in {@link ROUTING_TABLE_FILE}, the shared cell or the role's
 * `roles.<role>` cells; no schema change and no `CONTRACTS_VERSION` bump.
 */
export const routingChangeRule = (subject: Extract<UpstreamSubject, { kind: "routing" }>): string =>
  [
    `Change only the values of \`${ROUTING_TABLE_CONSTANT}\` in \`${ROUTING_TABLE_FILE}\`: the shared cell for size ${subject.size} with risk class \`${subject.risk}\`, or, when only \`${subject.role}\` differs, its cells under \`roles.${subject.role}\`.`,
    "Do not change the schema, any other file or `CONTRACTS_VERSION`; the routing scorecard charts are the evidence and the human merges it.",
  ].join(" ");
