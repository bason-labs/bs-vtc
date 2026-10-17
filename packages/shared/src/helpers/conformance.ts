/**
 * Role result conformance (§4.2 step 3, AD-14). Pure: checks a schema-valid {@link RoleResult}
 * against the effective contract of the role it was dispatched as, and against the dispatched
 * action itself. The engine rejects a non-conforming result with the returned `RejectReason`.
 */
import type { RejectReason } from "../event-payloads.js";
import { ACCEPTANCE_TESTS } from "../gate-result.js";
import type { FeatureId, RoleId, TaskId, VerdictSubject } from "../primitives.js";
import type { EffectiveRoleContract } from "../role-contract.js";
import type { RoleResult } from "../role-result.js";

/** Output artifact type a role must declare to submit `tasks` (the Planner's task drafts). */
export const TASKS_ARTIFACT = "tasks";

/** What the engine dispatched (`spawn_role` / `role.dispatched`). */
export interface DispatchedRole {
  readonly role: RoleId;
  readonly mode?: string | undefined;
  readonly task?: TaskId | undefined;
  readonly feature?: FeatureId | undefined;
  /** The one subject this call judges, e.g. the AC of a Spec-Verifier call. */
  readonly subject?: VerdictSubject | undefined;
}

export type ConformanceCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectReason; readonly issues: readonly string[] };

/**
 * A readable mismatch between a result field and the dispatch, never "undefined" (the owner's
 * first run, spine §5 reading 258): what the result named, what the dispatch has, and what to send.
 */
const mismatch = (
  field: "task" | "mode",
  returned: string | undefined,
  dispatched: string | undefined,
): string => {
  if (dispatched === undefined)
    return `the result names ${field} ${String(returned)}, but this dispatch has no ${field} (send ${field} null)`;
  if (returned === undefined)
    return `the result names no ${field}, but this dispatch is for ${field} ${dispatched} (send ${field} ${dispatched})`;
  return `the result names ${field} ${returned}, but this dispatch is for ${field} ${dispatched}`;
};

/**
 * Rules, checked in this order (the first failing group names the reason):
 * 1. `dispatch_mismatch`: role, task, feature or verdict subject differ from the dispatch;
 * 2. `undeclared_mode`: the mode differs from the dispatched mode;
 * 3. `undeclared_exit`: the exit is not in the contract's `exits`;
 * 4. `undeclared_verdict`: a verdict value is not in `output.verdicts`, or a role that declares
 *    verdicts finished (`done`) without one;
 * 5. `undeclared_output`: `tasks` without the `tasks` output artifact, `acceptance_tests`
 *    without the `acceptance_test` output artifact, or an artifact type the contract does not
 *    declare.
 */
export const checkResultAgainstContract = (
  result: RoleResult,
  contract: EffectiveRoleContract,
  dispatched: DispatchedRole,
): ConformanceCheck => {
  const groups: [RejectReason, string[]][] = [
    ["dispatch_mismatch", []],
    ["undeclared_mode", []],
    ["undeclared_exit", []],
    ["undeclared_verdict", []],
    ["undeclared_output", []],
  ];
  const add = (index: number, issue: string): void => {
    groups[index]?.[1].push(issue);
  };
  if (result.role !== dispatched.role || contract.id !== dispatched.role) {
    add(0, `role ${result.role} does not match the dispatched role ${dispatched.role}`);
  }
  if (result.task !== dispatched.task) add(0, mismatch("task", result.task, dispatched.task));
  if (dispatched.feature !== undefined && result.feature !== dispatched.feature) {
    add(0, `feature ${String(result.feature)} does not match ${dispatched.feature}`);
  }
  if (dispatched.subject !== undefined) {
    for (const v of result.verdicts) {
      if (v.subject !== dispatched.subject) {
        add(0, `verdict subject ${v.subject} is not the dispatched subject ${dispatched.subject}`);
      }
    }
  }
  if (result.mode !== dispatched.mode) {
    add(1, mismatch("mode", result.mode, dispatched.mode));
  } else if (contract.mode !== dispatched.mode) {
    add(
      1,
      `the contract's mode ${contract.mode ?? "(none)"} is not the dispatched mode ${dispatched.mode ?? "(none)"}`,
    );
  }
  if (!contract.exits.includes(result.exit)) {
    add(2, `exit ${result.exit} is not declared (${contract.exits.join(", ")})`);
  }
  const allowed = contract.output.verdicts;
  for (const v of result.verdicts) {
    if (!allowed.includes(v.verdict))
      add(3, `verdict ${v.verdict} on ${v.subject} is not declared`);
  }
  if (allowed.length > 0 && result.exit === "done" && result.verdicts.length === 0) {
    add(3, "the role declares verdicts but returned none");
  }
  const artifacts = contract.output.artifacts;
  if (result.tasks !== undefined && !artifacts.includes(TASKS_ARTIFACT)) {
    add(4, `tasks require the ${TASKS_ARTIFACT} output artifact`);
  }
  if (result.acceptance_tests !== undefined && !artifacts.includes(ACCEPTANCE_TESTS.artifactType)) {
    add(4, `acceptance_tests require the ${ACCEPTANCE_TESTS.artifactType} output artifact`);
  }
  for (const artifact of result.artifacts) {
    if (!artifacts.includes(artifact.type))
      add(
        4,
        `artifact type ${artifact.type} is not declared (${artifacts.length === 0 ? "this role declares no output artifacts" : `allowed: ${artifacts.join(", ")}`})`,
      );
  }
  const failed = groups.find(([, issues]) => issues.length > 0);
  return failed === undefined ? { ok: true } : { ok: false, reason: failed[0], issues: failed[1] };
};
