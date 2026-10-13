/**
 * Compiled agent names (AD-4 rule 4, AD-14). The compiler names each compiled agent with this
 * function, and the engine uses it to build the `agent` of a `spawn_role` action, so the two
 * never drift. One agent per role, or per role mode when the role declares modes.
 */
import { RoleIdSchema, SlugSchema } from "../primitives.js";

export const AGENT_NAME_PREFIX = "vtc-";

/**
 * `vtc-<role>[-<mode>]`, lower-case with hyphens only (`_` and `.` become `-`), e.g.
 * `agentNameFor("spec_verifier")` = `vtc-spec-verifier`, `agentNameFor("qa", "author")` =
 * `vtc-qa-author`. The same base name is used on both hosts; a host that namespaces plugin
 * agents adds its namespace inside its adapter, never in role sources.
 */
export const agentNameFor = (role: string, mode?: string): string => {
  const parts = [RoleIdSchema.parse(role)];
  if (mode !== undefined) parts.push(SlugSchema.parse(mode));
  return `${AGENT_NAME_PREFIX}${parts.join("-").replace(/[_.]/g, "-")}`;
};
