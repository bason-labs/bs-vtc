/**
 * The structured-output schema of one dispatch (contracts 5.12.0; spine §5 reading 258). Pure.
 *
 * `jsonSchemaFor("RoleResult", { target: "structured-output" })` describes every role: any task
 * id, any mode, any artifact type. A host that honours the schema (Codex `--output-schema`,
 * Claude `--json-schema`) could therefore still send what {@link checkResultAgainstContract}
 * rejects, and on the owner's first run a Codex BA did both: a task id on a task-less dispatch
 * and an artifact type its contract does not declare. This schema narrows the generic one to
 * what the dispatch and the role's effective contract allow, so such a result cannot be produced:
 *
 * - `role` is the dispatched role; `task`, `mode` and `feature` the dispatched values (the pack's
 *   Dispatch lines, which the result protocol says to copy), or `null` when the dispatch has none;
 * - `exit` is one of the contract's exits; `question`, `conflict` and `fault` are `null` unless
 *   the matching exit is declared;
 * - `artifacts[].type` is one of the contract's output artifact types (`null` when it declares
 *   none); `tasks` and `acceptance_tests` are `null` unless the matching output artifact is
 *   declared;
 * - `verdicts[].verdict` is one of the contract's verdicts (`null` when it declares none), and
 *   `verdicts[].subject` the dispatched subject when there is one.
 *
 * Field names, order and `required` stay those of the generic schema, so
 * `fromStructuredOutput("RoleResult", …)` parses the answer unchanged and the conformance check
 * still runs (JSON Schema cannot carry every rule).
 */
import { ACCEPTANCE_TESTS } from "../gate-result.js";
import { jsonSchemaFor, type JsonSchema } from "../json-schema.js";
import type { EffectiveRoleContract } from "../role-contract.js";
import { TASKS_ARTIFACT, type DispatchedRole } from "./conformance.js";

const NULL = { type: "null" } as const;

type Node = Record<string, unknown>;

const isNode = (value: unknown): value is Node =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pinned = (value: string | undefined): Node =>
  value === undefined ? { ...NULL } : { type: "string", enum: [value] };

/** The non-null member of a nullable property (`{ anyOf: [X, null] }` → X). */
const nonNull = (prop: unknown): Node => {
  if (isNode(prop) && Array.isArray(prop.anyOf)) {
    const member = (prop.anyOf as unknown[]).find((m) => isNode(m) && m.type !== "null");
    if (isNode(member)) return member;
  }
  return isNode(prop) ? prop : {};
};

const orNull = (schema: Node): Node => ({ anyOf: [schema, { ...NULL }] });

/** An array property whose items get `patch` merged into their `properties`. */
const withItemProps = (prop: unknown, patch: Node): Node => {
  const array = nonNull(prop);
  const items = isNode(array.items) ? array.items : {};
  const props = isNode(items.properties) ? items.properties : {};
  return orNull({ ...array, items: { ...items, properties: { ...props, ...patch } } });
};

export const roleResultSchemaFor = (
  dispatched: DispatchedRole,
  contract: EffectiveRoleContract,
): JsonSchema => {
  const generic = jsonSchemaFor("RoleResult", { target: "structured-output" });
  const props = isNode(generic.properties) ? generic.properties : {};
  const artifacts = contract.output.artifacts;
  const verdicts = contract.output.verdicts;
  const exits = contract.exits;
  const patch: Node = {
    role: { type: "string", enum: [dispatched.role] },
    mode: pinned(dispatched.mode),
    task: pinned(dispatched.task),
    feature: pinned(dispatched.feature),
    verdicts:
      verdicts.length === 0
        ? { ...NULL }
        : withItemProps(props.verdicts, {
            ...(dispatched.subject === undefined
              ? {}
              : { subject: { type: "string", enum: [dispatched.subject] } }),
            verdict: { type: "string", enum: [...verdicts] },
          }),
    tasks: artifacts.includes(TASKS_ARTIFACT) ? props.tasks : { ...NULL },
    acceptance_tests: artifacts.includes(ACCEPTANCE_TESTS.artifactType)
      ? props.acceptance_tests
      : { ...NULL },
    artifacts:
      artifacts.length === 0
        ? { ...NULL }
        : withItemProps(props.artifacts, { type: { type: "string", enum: [...artifacts] } }),
    exit: { type: "string", enum: [...exits] },
    question: exits.includes("blocked") ? props.question : { ...NULL },
    conflict: exits.includes("spec_conflict") ? props.conflict : { ...NULL },
    fault: exits.includes("out_of_scope_fault") ? props.fault : { ...NULL },
  };
  const properties = Object.fromEntries(
    Object.entries(props).map(([name, prop]) => [name, name in patch ? patch[name] : prop]),
  );
  return { ...generic, properties };
};
