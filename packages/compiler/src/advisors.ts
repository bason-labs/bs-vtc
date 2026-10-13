/**
 * Advisors (spec §5.4: Tier 3, "called through the Lead"; spine §5 readings 25 and 30). The
 * human asks the Lead for one; the Lead calls the engine's `consult` tool, which checks the role
 * is an advisor and the run's advisor budget, writes the pack and returns the one `spawn_role` to
 * perform; the Lead submits the advisor's `RoleResult` with `submit`. So every advisor call is
 * logged, priced and checked like a role's. What the compiler holds every advisor to:
 *
 * - its id starts with `advisor_` (agent `vtc-advisor-<name>`), and only advisors use that
 *   prefix, so advisor agents stay distinguishable from the run's roles;
 * - its reviewer is the human who asked, who reads the advice and decides whether to act on it
 *   through the engine (a new run, a change request or an escalation answer);
 * - it is read-only, except that it may be `write_scoped` to the exports directory
 *   ({@link ADVISOR_WRITE_PATHS}) with exactly the {@link ADVISOR_EXPORT_ARTIFACT} output
 *   artifact (reading 30: the client liaison; the engine checks the write on submit);
 * - it returns no verdicts, declares no success criteria and no modes;
 * - it exits `done`, `blocked` (a question for the human) or `unknown`.
 */
import type { RoleContract, RoleExit } from "@vtc/shared";

export const ADVISOR_PREFIX = "advisor_";

/** Who reviews an advisor's output: the human it is written for (not a role, not the engine). */
export const ADVISOR_REVIEWER = "human";

export const ADVISOR_EXITS: readonly RoleExit[] = ["done", "blocked", "unknown"];

/** The only place an advisor may write (spine §5 reading 30). */
export const ADVISOR_WRITE_PATHS: readonly string[] = [".vtc/exports/**"];

/** The only output artifact type an advisor may declare, and only when it is write-scoped. */
export const ADVISOR_EXPORT_ARTIFACT = "client_export";

/** Every advisor rule `role` breaks; empty for a valid advisor and for every other role. */
export const advisorContractErrors = (role: RoleContract): string[] => {
  const prefixed = role.id.startsWith(ADVISOR_PREFIX);
  if (role.kind !== "advisor") {
    return prefixed ? [`only advisors (kind advisor) may use the ${ADVISOR_PREFIX} prefix`] : [];
  }
  const errors: string[] = [];
  if (!prefixed) errors.push(`advisor role ids start with ${ADVISOR_PREFIX}`);
  const { profile, write_paths: paths } = role.tools;
  const exportsOnly =
    profile === "write_scoped" && paths.every((path) => ADVISOR_WRITE_PATHS.includes(path));
  if (profile !== "read_only" && !exportsOnly) {
    errors.push(
      `advisors are read_only, or write_scoped to ${ADVISOR_WRITE_PATHS.join(", ")} only (spine §5 reading 30)`,
    );
  }
  const artifacts = role.output.artifacts;
  const expected = profile === "write_scoped" ? [ADVISOR_EXPORT_ARTIFACT] : [];
  if (artifacts.length !== expected.length || artifacts.some((a, i) => a !== expected[i])) {
    errors.push(
      `advisor output artifacts: none when read_only, exactly ${ADVISOR_EXPORT_ARTIFACT} when write_scoped`,
    );
  }
  if (role.output.verdicts.length > 0) errors.push("advisors return advice, not verdicts");
  if (role.reviewer !== ADVISOR_REVIEWER) {
    errors.push(`an advisor's reviewer is ${ADVISOR_REVIEWER}`);
  }
  const extra = role.exits.filter((exit) => !ADVISOR_EXITS.includes(exit));
  if (extra.length > 0) {
    errors.push(`advisor exits are ${ADVISOR_EXITS.join(", ")}; not ${extra.join(", ")}`);
  }
  if (role.success_criteria.length > 0) {
    errors.push(
      "advisors declare no success_criteria: the engine runs no success checks on advice",
    );
  }
  if (role.modes !== undefined) errors.push("advisors declare no modes");
  return errors;
};
