/**
 * Advisors (spec §5.4: Tier 3, "called through the Lead"; role catalogue §7.4: a manual trigger
 * outside the automated flow). The frozen engine surface has no advisor action: the engine never
 * dispatches an advisor, never sees its result and runs no write-scope check on it. So an advisor
 * compiles only when nothing about it needs the engine:
 *
 * - its id starts with `advisor_` (agent `vtc-advisor-<name>`), and only advisors use that
 *   prefix, so advisor agents stay distinguishable from the run's roles (the Lead skill holds
 *   them out of its loop until the engine has an action for them; see roles/README.md);
 * - it is read-only (nothing would check a write), returns advice rather than output artifacts or
 *   verdicts, and declares no engine-checked success criteria and no modes;
 * - its reviewer is the human, who reads the advice and decides whether to act on it through the
 *   engine (a new run, a change request or an escalation answer);
 * - it exits `done`, `blocked` (a question the Lead puts to the human) or `unknown`.
 */
import type { RoleContract, RoleExit } from "@vtc/shared";

export const ADVISOR_PREFIX = "advisor_";

/** Who reviews an advisor's output: the human it is written for (not a role, not the engine). */
export const ADVISOR_REVIEWER = "human";

export const ADVISOR_EXITS: readonly RoleExit[] = ["done", "blocked", "unknown"];

/** Every advisor rule `role` breaks; empty for a valid advisor and for every other role. */
export const advisorContractErrors = (role: RoleContract): string[] => {
  const prefixed = role.id.startsWith(ADVISOR_PREFIX);
  if (role.kind !== "advisor") {
    return prefixed ? [`only advisors (kind advisor) may use the ${ADVISOR_PREFIX} prefix`] : [];
  }
  const errors: string[] = [];
  if (!prefixed) errors.push(`advisor role ids start with ${ADVISOR_PREFIX}`);
  if (role.tools.profile !== "read_only") {
    errors.push("advisors are read_only: nothing checks what they write");
  }
  if (role.output.artifacts.length > 0 || role.output.verdicts.length > 0) {
    errors.push("advisors return advice, not output artifacts or verdicts");
  }
  if (role.reviewer !== ADVISOR_REVIEWER) {
    errors.push(`an advisor's reviewer is ${ADVISOR_REVIEWER}`);
  }
  const extra = role.exits.filter((exit) => !ADVISOR_EXITS.includes(exit));
  if (extra.length > 0) {
    errors.push(`advisor exits are ${ADVISOR_EXITS.join(", ")}; not ${extra.join(", ")}`);
  }
  if (role.success_criteria.length > 0) {
    errors.push("advisors declare no success_criteria: the engine never sees their result");
  }
  if (role.modes !== undefined) errors.push("advisors declare no modes");
  return errors;
};
