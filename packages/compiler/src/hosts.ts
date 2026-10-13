/**
 * Host formats (§12.1): Claude Code plugin agents (`agents/*.md`, frontmatter + body) and Codex
 * custom agents (`agents/*.toml`, written into `.codex/agents/` by the installer, AD-16 rule 4).
 * No emitted file sets a permission mode or a full-access sandbox (AD-9): read-only enforcement
 * comes from tool allowlists, the Codex sandbox, the OS sandbox and the engine's write-scope check.
 */
import {
  ENGINE_INSTANCE,
  engineMcpServer,
  HIDDEN_TESTS,
  HOST_CREDENTIAL_DENY_READ,
  ROLE_DENIED_VTC,
  type ModelTier,
  type RoleTools,
} from "@vtc/shared";
import { renderFrontmatter } from "./frontmatter.js";
import { tomlMultiline, tomlString, tomlStringArray } from "./toml.js";
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
 * Explicit tool allowlist per profile: read-only roles get no write or shell tool; write-scoped
 * roles get file writes (the engine checks the paths); only the Engineer family gets Bash.
 * The engine MCP tools a role declares are added by their plugin names.
 */
export const claudeToolsFor = (tools: RoleTools): string[] => [
  ...READ_TOOLS,
  ...(tools.profile === "read_only" ? [] : WRITE_TOOLS),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...tools.engine_tools.map(claudeEngineToolName),
];

/**
 * What every Claude Code role agent is denied, whatever its profile (D-w, spine §5 reading 43):
 * running each `ROLE_DENIED_VTC` subcommand of `vtc`, and file writes (`Edit`, `Write`) to each
 * guarded glob under the VTC home. In plugin-only mode (AD-17) no adapter sandbox profile is
 * built, so the agent also carries its own read denies: the install token, the hidden acceptance
 * tests (§7.3), the daemons' socket directory and the Codex home. Claude's own credential file is
 * not named here: an emitted plugin file may not carry a credential marker (AD-9; the D-ad
 * exemption covers only the adapter's settings), so in this mode it rests on the Lead session's
 * own permissions. The rules name the default homes `~/.vtc/` and `~/.codex/`; a `$VTC_HOME` or
 * `$CODEX_HOME` elsewhere is not known when the plugin is compiled, and the adapter's sandbox
 * profile, which resolves them, stays the barrier for headless runs. A read-only agent has none of
 * the write tools, but gets the same list so no agent depends on its allowlist alone.
 */
export const CLAUDE_DENIED_TOOLS: readonly string[] = [
  ...ROLE_DENIED_VTC.subcommands.map((sub) => `Bash(vtc ${sub}:*)`),
  ...ROLE_DENIED_VTC.homeWriteDeny.flatMap((glob) =>
    ["Edit", "Write"].map((tool) => `${tool}(~/.vtc/${glob})`),
  ),
  `Read(~/.vtc/${ENGINE_INSTANCE.tokenFile})`,
  `Read(~/.vtc/${HIDDEN_TESTS.homeDir}/**)`,
  `Read(~/.vtc/${ENGINE_INSTANCE.socketDir}/**)`,
  `Read(~/${HOST_CREDENTIAL_DENY_READ.codex.defaultConfigDir}/**)`,
];

export const renderClaudeAgent = (agent: CompiledAgent): string =>
  renderFrontmatter(
    {
      name: agent.name,
      description: agent.description,
      tools: claudeToolsFor(agent.tools).join(", "),
      disallowedTools: CLAUDE_DENIED_TOOLS.join(", "),
      model: agent.model.model ?? CLAUDE_MODEL_ALIASES[agent.model.tier],
      effort: agent.model.effort,
    },
    agent.instructions,
  );

/** Codex sandbox per profile; reviewers stay read-only (§12.1 "sandbox_mode per agent"). */
export const codexSandboxFor = (tools: RoleTools): "read-only" | "workspace-write" =>
  tools.profile === "read_only" ? "read-only" : "workspace-write";

/**
 * The agent's own `[mcp_servers.vtc]` table. The plugin registers the engine bridge for the whole
 * session, and it serves the Lead's run-driving tools; a role agent must not reach them (AD-8
 * rule 3: not a prompt rule). A role with no engine tools gets the server disabled, otherwise only
 * its tools enabled. The entry repeats the full `engineMcpServer("codex")` command so it is valid
 * whether Codex merges or replaces the session's entry. Unverified: spine §7 does not yet list
 * the check that spawned Codex agents honour a per-agent `mcp_servers` table with `enabled` and
 * `enabled_tools`. That spike item, and an engine-side guard so that a role agent's session cannot
 * approve a gate or answer an escalation, are proposed to the integrator; until both land this
 * table is the only barrier on Codex.
 */
export const codexMcpTable = (tools: RoleTools): string[] => {
  const entry = engineMcpServer("codex");
  return [
    `[mcp_servers.${entry.name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = ${tomlStringArray(entry.args)}`,
    tools.engine_tools.length === 0
      ? "enabled = false"
      : `enabled_tools = ${tomlStringArray(tools.engine_tools)}`,
  ];
};

/**
 * A Codex agent file. It sets only `model_reasoning_effort`, never a model (spine §5 readings 26
 * and 51, D-h, D-ae): the engine is the only model resolver, its built-in Codex map names no ids
 * until the spike does, and `spawn_role.model` is then absent, so every Codex agent runs on the
 * session's model and `role.yaml` may not pin one for Codex (`codexModelErrors`).
 *
 * The VTC guard rails (D-w, `ROLE_DENIED_VTC`) cannot be named per agent on Codex: a command
 * deny is a session-level execpolicy rule, not an agent key. The barrier is the sandbox: a
 * read-only or workspace-write `sandbox_mode` with no writable roots of its own keeps the VTC
 * home outside every role's writes, `vtc calibrate`'s included; the adapter's sandbox profile
 * covers the rest. Every key is a top-level Codex config key, so whichever way the headless role
 * identity spike loads a role (`codex exec` has no `--agent`), this file carries over as is.
 */
export const renderCodexAgent = (agent: CompiledAgent): string =>
  [
    `# Generated by @vtc/compiler from roles/${agent.role}${agent.mode === undefined ? "" : ` (mode ${agent.mode})`} v${agent.roleVersion}. Do not edit.`,
    `name = ${tomlString(agent.name)}`,
    `description = ${tomlString(agent.description)}`,
    `model_reasoning_effort = ${tomlString(agent.model.effort)}`,
    `sandbox_mode = ${tomlString(codexSandboxFor(agent.tools))}`,
    `developer_instructions = ${tomlMultiline(agent.instructions)}`,
    "",
    ...codexMcpTable(agent.tools),
    "",
  ].join("\n");
