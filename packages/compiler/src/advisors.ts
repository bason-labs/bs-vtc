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
 * - it exits `done`, `blocked` (a question for the human) or `unknown`;
 * - its first input is {@link ADVISOR_QUESTION_ARTIFACT}, the human's question, and only advisors
 *   read that type. `request` keeps its shared meaning, the run's idea or change request.
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

/**
 * The artifact type of the human's consult question (`ConsultInput.question`), which the engine
 * writes to a file and lists first in the advisor's pack inputs. Provisional: proposed to
 * `@vtc/shared` (MINOR: a `KNOWN_ARTIFACT_TYPES` entry and a path helper next to `taskPackPath`);
 * until it lands the advisor prompts and role contracts already use this name, so the engine has
 * one reading to build to. `request` stays the run's request (`PACK_INPUT_TYPES.request`).
 */
export const ADVISOR_QUESTION_ARTIFACT = "advisor_question";

/**
 * Artifact types the roles use that are proposed to `@vtc/shared` but not in
 * `KNOWN_ARTIFACT_TYPES` yet. Drop an entry once shared adds it.
 */
export const PROPOSED_ARTIFACT_TYPES: readonly string[] = [ADVISOR_QUESTION_ARTIFACT];

/** Every advisor rule `role` breaks; empty for a valid advisor and for every other role. */
export const advisorContractErrors = (role: RoleContract): string[] => {
  const prefixed = role.id.startsWith(ADVISOR_PREFIX);
  if (role.kind !== "advisor") {
    const inputs = [
      ...role.inputs,
      ...Object.values(role.modes ?? {}).flatMap((mode) => mode.inputs ?? []),
    ];
    return [
      ...(prefixed ? [`only advisors (kind advisor) may use the ${ADVISOR_PREFIX} prefix`] : []),
      ...(inputs.includes(ADVISOR_QUESTION_ARTIFACT)
        ? [`only advisors read ${ADVISOR_QUESTION_ARTIFACT} (the consult question)`]
        : []),
    ];
  }
  const errors: string[] = [];
  if (!prefixed) errors.push(`advisor role ids start with ${ADVISOR_PREFIX}`);
  if (role.inputs[0] !== ADVISOR_QUESTION_ARTIFACT) {
    errors.push(
      `advisors read the human's question as their first input, ${ADVISOR_QUESTION_ARTIFACT} (the run's request is \`request\`, not the question)`,
    );
  }
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
