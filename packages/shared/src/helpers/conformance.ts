/**
 * Role result conformance (§4.2 step 3, AD-14). Pure: checks a schema-valid {@link RoleResult}
 * against the effective contract of the role it was dispatched as, and against the dispatched
 * action itself. The engine rejects a non-conforming result with the returned `RejectReason`.
 */
import type { RejectReason } from "../event-payloads.js";
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
 * Rules, checked in this order (the first failing group names the reason):
 * 1. `dispatch_mismatch`: role, task, feature or verdict subject differ from the dispatch;
 * 2. `undeclared_mode`: the mode differs from the dispatched mode;
 * 3. `undeclared_exit`: the exit is not in the contract's `exits`;
 * 4. `undeclared_verdict`: a verdict value is not in `output.verdicts`, or a role that declares
 *    verdicts finished (`done`) without one;
 * 5. `undeclared_output`: `tasks` without the `tasks` output artifact, or an artifact type the
 *    contract does not declare.
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
  if (result.task !== dispatched.task) {
    add(0, `task ${String(result.task)} does not match the dispatched ${String(dispatched.task)}`);
  }
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
  if (result.mode !== dispatched.mode || contract.mode !== dispatched.mode) {
    add(1, `mode ${String(result.mode)} does not match the dispatched ${String(dispatched.mode)}`);
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
  for (const artifact of result.artifacts) {
    if (!artifacts.includes(artifact.type))
      add(4, `artifact type ${artifact.type} is not declared`);
  }
  const failed = groups.find(([, issues]) => issues.length > 0);
  return failed === undefined ? { ok: true } : { ok: false, reason: failed[0], issues: failed[1] };
};
