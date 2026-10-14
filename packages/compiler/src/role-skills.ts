/**
 * Skills an agent needs in context (spec §8.1, §10; spine AD-22): a role's own reference skill
 * (the Architect's method references) and the skill that teaches each role-facing engine tool
 * the role declares (`ROLE_MCP_TOOLS`). On Claude Code the agent preloads them through its
 * `skills` frontmatter (code.claude.com/docs/en/sub-agents, "Preload skills into subagents"),
 * because an agent without the `Skill` tool cannot load one itself; plugin skills are namespaced
 * by the plugin (`vtc:<skill>`). A Codex session lists every installed skill with its path, so a
 * Codex agent file names none.
 */
import type { RoleMcpToolName } from "@vtc/shared";

/** A role's own skill(s), by role id. */
export const ROLE_SKILLS: Readonly<Record<string, readonly string[]>> = {
  architect: ["architect"],
};

/** The skill that teaches each role-facing engine tool. */
export const TOOL_SKILLS: Readonly<Record<RoleMcpToolName, string>> = {
  research_fetch: "research-fetch",
  fact_lookup: "research-facts",
  fact_propose: "research-facts",
};

/**
 * In skill sources, the directory of the skill's `SKILL.md`. Claude Code substitutes it in a
 * skill's content (code.claude.com/docs/en/skills); the compiler removes it from the Codex copy,
 * where a path relative to `SKILL.md` already resolves.
 */
export const CLAUDE_SKILL_DIR = "${CLAUDE_SKILL_DIR}";

/** A skill file's text for `host`: on Codex, `${CLAUDE_SKILL_DIR}/x` becomes the relative `x`. */
export const skillTextFor = (host: "claude-code" | "codex", text: string): string =>
  host === "codex" ? text.replaceAll(`${CLAUDE_SKILL_DIR}/`, "") : text;

export interface SkillNeeds {
  /** Skill names, sorted and unique. */
  readonly skills: readonly string[];
  readonly errors: readonly string[];
}

/** The skills one agent preloads, checked against the skills that exist. */
export const skillsForAgent = (
  roleId: string,
  engineTools: readonly string[],
  available: ReadonlySet<string>,
): SkillNeeds => {
  const errors: string[] = [];
  const wanted = new Set<string>();
  for (const skill of ROLE_SKILLS[roleId] ?? []) {
    if (available.has(skill)) wanted.add(skill);
    else errors.push(`needs its skill skills/${skill}`);
  }
  for (const tool of engineTools) {
    const skill = (TOOL_SKILLS as Readonly<Record<string, string>>)[tool];
    if (skill === undefined) continue;
    if (available.has(skill)) wanted.add(skill);
    else errors.push(`engine tool ${tool} needs the skill skills/${skill}`);
  }
  return { skills: [...wanted].sort(), errors };
};
