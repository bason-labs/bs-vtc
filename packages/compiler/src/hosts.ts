/**
 * Host formats (§12.1): Claude Code plugin agents (`agents/*.md`, frontmatter + body) and Codex
 * custom agents (`agents/*.toml`, written into `.codex/agents/` by the installer, AD-16 rule 4).
 * No emitted file sets a permission mode or a full-access sandbox (AD-9): read-only enforcement
 * comes from tool allowlists, the Codex sandbox, the OS sandbox and the engine's write-scope check.
 */
import {
  engineMcpServer,
  humanChannelRequired,
  isHumanOnlyTool,
  HUMAN_ONLY_TOOLS,
  type ModelTier,
  type RoleTools,
} from "@vtc/shared";
import { renderFrontmatter } from "./frontmatter.js";
import { tomlMultiline, tomlString } from "./toml.js";
import type { CompiledAgent } from "./types.js";

/**
 * Plugin name on both hosts. The MCP server it registers is also `vtc` (`engineMcpServer`).
 * Claude Code lists plugin agents as `<plugin>:<agent>`, so an engine-launched headless run
 * resolves `--agent vtc:<agent>` (D-aa, spine §5 reading 47); agent files carry the bare name.
 */
export const PLUGIN_NAME = "vtc";

/** Claude Code model aliases per tier (§5.2 footnote: top/mid/low = Opus/Sonnet/Haiku). */
export const CLAUDE_MODEL_ALIASES: Readonly<Record<ModelTier, string>> = {
  top: "opus",
  mid: "sonnet",
  low: "haiku",
};

/** Claude Code names plugin MCP tools `mcp__plugin_<plugin>_<server>__<tool>`. */
export const claudeEngineToolName = (tool: string): string =>
  `mcp__plugin_${PLUGIN_NAME}_${PLUGIN_NAME}__${tool}`;

const READ_TOOLS = ["Read", "Grep", "Glob"] as const;
const WRITE_TOOLS = ["Write", "Edit"] as const;

/**
 * A role's engine tools, refusing any human-only one (D-an, spine §5 reading 71): `approve`,
 * `answer` and `change_request` record a human decision, so no compiled agent may name one in
 * its `tools` (Claude Code) or `enabled_tools` (Codex), whatever its contract says. The compile
 * step already rejects such a `role.yaml` (`engineToolErrors`); this keeps the renderers safe on
 * their own.
 */
const roleEngineTools = (tools: RoleTools): readonly string[] => {
  const human = tools.engine_tools.find(isHumanOnlyTool);
  if (human !== undefined) {
    throw new TypeError(`no role agent may name ${human}: ${humanChannelRequired(human)}`);
  }
  return tools.engine_tools;
};

/**
 * Claude Code's own web search and page fetch, for a role whose contract sets `host_web` (H-3,
 * spine §5 reading 156; AD-22 rule 6). `RoleToolsSchema` refuses `host_web` on a
 * `code_sandboxed` role, so no agent with a shell gets them.
 */
export const CLAUDE_HOST_WEB_TOOLS = ["WebSearch", "WebFetch"] as const;

/**
 * An engine tool as a headless run's `--mcp-config` bridge names it: `mcp__<server>__<tool>`
 * (`engineMcpServer`). Under `--strict-mcp-config` it may be the only name the engine tools have
 * (spine §7 row "Claude headless plugin agent"), so an agent lists both names.
 */
export const claudeBridgeToolName = (tool: string): string =>
  `mcp__${engineMcpServer("claude-code").name}__${tool}`;

/**
 * The tools every compiled Claude agent lists besides its profile's (spine §7, live check
 * 2026-10-14). A headless role run is `--agent vtc:<agent>`, and under `--agent` the session's
 * tools are cut to the agent's own `tools`: `StructuredOutput` is how `--json-schema` returns the
 * RoleResult (without it the run ends with no `structured_output` and the engine rejects it), and
 * `ToolSearch` loads the engine tools when Claude defers them. Neither reaches a file or the
 * network; in an in-session subagent, where neither flag applies, the host has no such tool to
 * give and the names are inert.
 */
export const CLAUDE_SESSION_TOOLS = ["ToolSearch", "StructuredOutput"] as const;

/**
 * Explicit tool allowlist per profile: read-only roles get no write or shell tool; write-scoped
 * roles get file writes (the engine checks the paths); only the Engineer family gets Bash; only
 * a `host_web` role gets the host's web tools. Every agent gets {@link CLAUDE_SESSION_TOOLS}. The
 * engine MCP tools a role declares are added by their plugin names and by the headless bridge's
 * ({@link claudeBridgeToolName}), the two names the adapter allows; a human-only one throws.
 * `tests` in `packages/cli` check this list against the adapter's `--allowedTools` for every
 * compiled agent.
 */
export const claudeToolsFor = (tools: RoleTools): string[] => [
  ...READ_TOOLS,
  ...(tools.profile === "read_only" ? [] : WRITE_TOOLS),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...(tools.host_web === true ? CLAUDE_HOST_WEB_TOOLS : []),
  ...CLAUDE_SESSION_TOOLS,
  ...roleEngineTools(tools).flatMap((tool) => [
    claudeEngineToolName(tool),
    claudeBridgeToolName(tool),
  ]),
];

/**
 * What every Claude Code role agent's frontmatter `disallowedTools` names: every human-only
 * engine tool (`HUMAN_ONLY_TOOLS`) by its plugin name and by the headless bridge's
 * ({@link claudeBridgeToolName}), on top of the `tools` allowlist that never names one (D-an,
 * spine §5 reading 71). Bare tool names only (spine §5 reading 81): in
 * subagent frontmatter an entry with a specifier, such as `Bash(vtc calibrate *)` or
 * `Read(~/.vtc/token)`, removes the whole tool, not the matching calls
 * (code.claude.com/docs/en/sub-agents, "disallowedTools"), and with `--agent` the main thread
 * takes on the same restriction. The path and command rules that used to sit here (the VTC home,
 * the Codex home, the repo's gate files, `vtc calibrate`, the shell spellings of the home) are
 * `permissions.deny` rules now: in the Lead session's `.claude/settings.local.json`, which
 * `vtc install` writes (`claudeSessionPermissionDeny`, absolute paths, so they also cover a
 * `$VTC_HOME` elsewhere), and in a headless run's `--settings` (the adapter's profile).
 */
export const CLAUDE_DENIED_TOOLS: readonly string[] = HUMAN_ONLY_TOOLS.flatMap((tool) => [
  claudeEngineToolName(tool),
  claudeBridgeToolName(tool),
]);

/** A frontmatter tool list entry is a bare tool name: a specifier would remove the whole tool. */
const assertBareToolNames = (field: string, entries: readonly string[]): readonly string[] => {
  const scoped = entries.find((e) => /[()]/.test(e));
  if (scoped !== undefined) {
    throw new TypeError(
      `agent frontmatter ${field} may name only bare tools; ${scoped} would remove the whole tool (put path and command rules in permissions.deny)`,
    );
  }
  return entries;
};

/** Claude Code names plugin skills `<plugin>:<skill>` (code.claude.com/docs/en/skills). */
export const claudeSkillName = (skill: string): string => `${PLUGIN_NAME}:${skill}`;

/**
 * A Claude Code agent file. `skills` preloads the agent's skills (`role-skills.ts`): the agent's
 * `tools` never include `Skill`, so preloading is the only way a skill reaches it.
 */
export const renderClaudeAgent = (agent: CompiledAgent): string =>
  renderFrontmatter(
    {
      name: agent.name,
      description: agent.description,
      tools: assertBareToolNames("tools", claudeToolsFor(agent.tools)).join(", "),
      disallowedTools: assertBareToolNames("disallowedTools", CLAUDE_DENIED_TOOLS).join(", "),
      model: agent.model.model ?? CLAUDE_MODEL_ALIASES[agent.model.tier],
      effort: agent.model.effort,
      ...(agent.skills.length === 0 ? {} : { skills: agent.skills.map(claudeSkillName) }),
    },
    agent.instructions,
  );

/**
 * The Codex `[features]` a role agent turns off (spine §5 reading 82). A Codex custom agent file
 * cannot set `sandbox_mode`, `approval_policy` or `mcp_servers`: "They inherit the parent's
 * permissions, provider, and MCP servers; a custom agent file can't override those settings"
 * (developers.openai.com/codex/subagents, "Custom agents"). The only per-agent reductions it
 * offers are `features.<key> = false` (`shell_tool`, `apps`, `plugins`, `memories`,
 * `request_permissions_tool`) and `skills.*`. So a role agent turns off what its profile does not
 * need: the shell for every role but the Engineer family (Claude's `Bash` allowlist), and the
 * permission-request tool for every role (no role asks the human for a wider sandbox). The
 * sandbox, the network and the engine bridge a Codex role gets are the parent session's; that is
 * why the engine dispatches no Codex role in-session (`inSessionDispatchRefusal`) until the
 * session's own sandbox is shown network-off.
 *
 * Host web search (`RoleTools.host_web`, H-3) has no per-agent switch in that list either, so a
 * Codex agent file names none: a headless `codex exec` role run sets web search for a `host_web`
 * role through the adapter's own flags, and only ever `CODEX_HOST_WEB_SEARCH` (`cached`, D-cf,
 * spine §5 reading 200), never a live page fetch; the agent's contract line says so
 * (`HOST_WEB_LINES`).
 */
export const codexFeaturesFor = (tools: RoleTools): Readonly<Record<string, false>> => ({
  ...(tools.profile === "code_sandboxed" ? {} : { shell_tool: false }),
  request_permissions_tool: false,
});

/**
 * A Codex agent file: `name`, `description`, `developer_instructions` (required), the reasoning
 * effort, and `[features]` ({@link codexFeaturesFor}). It sets only `model_reasoning_effort`,
 * never a model (spine §5 readings 26 and 51, D-h, D-ae): the engine is the only model resolver,
 * its built-in Codex map names no ids until the spike does, and `spawn_role.model` is then
 * absent, so every Codex agent runs on the session's model and `role.yaml` may not pin one for
 * Codex (`codexModelErrors`).
 *
 * No `sandbox_mode`, `[sandbox_workspace_write]` or `[mcp_servers]` (spine §5 reading 82): Codex
 * ignores them in a custom agent file and the agent inherits the parent session's, so emitting
 * them would only suggest a barrier that is not there. The engine's Lead-only and human-channel
 * checks (reading 71) are the barrier on the bridge; a headless `codex exec` role run sets its
 * sandbox with `-c` overrides (the adapter's profile).
 */
export const renderCodexAgent = (agent: CompiledAgent): string => {
  // a human-only engine tool in a role contract is refused on this host too (D-an)
  roleEngineTools(agent.tools);
  return [
    `# Generated by @vtc/compiler from roles/${agent.role}${agent.mode === undefined ? "" : ` (mode ${agent.mode})`} v${agent.roleVersion}. Do not edit.`,
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `model_reasoning_effort = ${tomlString(agent.model.effort)}`,
    `developer_instructions = ${tomlMultiline(agent.instructions)}`,
    "",
    "[features]",
    ...Object.entries(codexFeaturesFor(agent.tools)).map(
      ([key, value]) => `${key} = ${String(value)}`,
    ),
    "",
  ].join("\n");
};
