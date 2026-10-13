/**
 * Host formats (§12.1): Claude Code plugin agents (`agents/*.md`, frontmatter + body) and Codex
 * custom agents (`agents/*.toml`, written into `.codex/agents/` by the installer, AD-16 rule 4).
 * No emitted file sets a permission mode or a full-access sandbox (AD-9): read-only enforcement
 * comes from tool allowlists, the Codex sandbox, the OS sandbox and the engine's write-scope check.
 */
import {
  engineMcpServer,
  HOST_CREDENTIAL_DENY_READ,
  humanChannelRequired,
  isHumanOnlyTool,
  HUMAN_ONLY_TOOLS,
  REPO_ROLE_DENIED,
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
 * Explicit tool allowlist per profile: read-only roles get no write or shell tool; write-scoped
 * roles get file writes (the engine checks the paths); only the Engineer family gets Bash.
 * The engine MCP tools a role declares are added by their plugin names; a human-only one throws.
 */
export const claudeToolsFor = (tools: RoleTools): string[] => [
  ...READ_TOOLS,
  ...(tools.profile === "read_only" ? [] : WRITE_TOOLS),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...roleEngineTools(tools).map(claudeEngineToolName),
];

/** A guarded glob under the VTC home without its trailing `/**`: the path a command names. */
const homeRoot = (glob: string): string => glob.replace(/\/\*\*$/, "");

/**
 * How a shell command may spell a path under the default VTC home, or under `$VTC_HOME` (the
 * cli's override, `project-config.ts`). Claude Code matches a Bash rule against the command text
 * as written, so each spelling needs its own rule.
 */
export const VTC_HOME_SHELL_SPELLINGS: readonly string[] = [
  "~/.vtc",
  "$HOME/.vtc",
  "${HOME}/.vtc",
  "$VTC_HOME",
  "${VTC_HOME}",
];

/**
 * Shell-level denies for every guarded VTC home path, read or write (D-an, D-ap; spine §5
 * readings 71 and 73): `Bash(*<home>/<path>*)` for each path in `ROLE_DENIED_VTC.homeWriteDeny`
 * and `homeReadDeny` and each {@link VTC_HOME_SHELL_SPELLINGS} spelling. In a Claude Code Bash
 * rule `*` matches any text, so any command that names one of those paths is refused, whatever
 * the program. The `Read`/`Edit`/`Write` rules already cover the file commands Claude Code
 * recognises (`cat`, `sed`, `tee`, redirections); these catch the rest that name the path
 * (`cp`, `nc -U`, `socat`, a script given the path). They are best effort by construction: a
 * command that reaches the path without naming it (`cd ~/.vtc && cat token`, a script that
 * builds the path itself, an absolute `/Users/<me>/.vtc`) is not matched. The barrier for a
 * code-running role in-session is the Lead session's own sandbox, which `vtc install` writes and
 * the engine requires before such a dispatch (`claudeSessionSandboxSettings`,
 * `inSessionDispatchAllowed`); the remainder is the spine §7 residual "Plugin-only in-session
 * roles". A role never needs a shell on these paths, so the rules cost no legitimate command.
 * They name only VTC-home spellings, never a bare `.vtc/`, so the project's own `.vtc/` (its
 * `config.yaml`, `runs/`, `state/`) stays reachable.
 */
export const CLAUDE_SHELL_HOME_DENIES: readonly string[] = [
  ...new Set([...ROLE_DENIED_VTC.homeWriteDeny, ...ROLE_DENIED_VTC.homeReadDeny].map(homeRoot)),
].flatMap((root) => VTC_HOME_SHELL_SPELLINGS.map((home) => `Bash(*${home}/${root}*)`));

/**
 * What every Claude Code role agent is denied, whatever its profile (D-w, spine §5 reading 43;
 * D-an and D-ap, readings 71 and 73), in this order:
 * - running each `ROLE_DENIED_VTC` subcommand of `vtc`;
 * - file writes (`Edit`, `Write`) to each `ROLE_DENIED_VTC.homeWriteDeny` glob under the VTC home;
 * - reads of each `ROLE_DENIED_VTC.homeReadDeny` glob (the install token, the daemons' sockets,
 *   the hidden acceptance tests, §7.3) and of the Codex home: in plugin-only mode (AD-17) no
 *   adapter sandbox profile is built, so the agent carries its own read denies;
 * - reads of the repo's engine gate files and writes to them and to the run config
 *   (`REPO_ROLE_DENIED`, spine §5 reading 79: the verification checkouts hold the hidden tests
 *   during a gate run, the raw gate output what hidden runs printed). The paths are relative to
 *   the session's directory with a leading `**` so any checkout depth matches; the absolute,
 *   shell-proof form is in the Lead session's sandbox (`claudeSessionSandboxSettings`);
 * - {@link CLAUDE_SHELL_HOME_DENIES}, the shell-level denies for those paths;
 * - every human-only engine tool (`HUMAN_ONLY_TOOLS`) by its plugin name, on top of the `tools`
 *   allowlist that never names one.
 * Claude's own credential file is not named here: an emitted plugin file may not carry a
 * credential marker (AD-9; the D-ad exemption covers only the host settings VTC writes), so in
 * this mode it rests on the Lead session's sandbox, whose settings (`vtc install`) read-deny both
 * hosts' credential files and the home credential stores (spine §5 reading 79). The file rules name the
 * default homes `~/.vtc/` and `~/.codex/`; a `$VTC_HOME` or `$CODEX_HOME` elsewhere is not known
 * when the plugin is compiled, and the session sandbox (in-session) or the adapter's sandbox
 * profile (headless), which resolve them, stay the barrier. A read-only agent has none of the
 * write tools, but gets the same list so no agent depends on its allowlist alone.
 */
export const CLAUDE_DENIED_TOOLS: readonly string[] = [
  ...ROLE_DENIED_VTC.subcommands.map((sub) => `Bash(vtc ${sub}:*)`),
  ...ROLE_DENIED_VTC.homeWriteDeny.flatMap((glob) =>
    ["Edit", "Write"].map((tool) => `${tool}(~/.vtc/${glob})`),
  ),
  ...ROLE_DENIED_VTC.homeReadDeny.map((glob) => `Read(~/.vtc/${glob})`),
  `Read(~/${HOST_CREDENTIAL_DENY_READ.codex.defaultConfigDir}/**)`,
  ...REPO_ROLE_DENIED.readDeny.map((glob) => `Read(**/${glob})`),
  ...REPO_ROLE_DENIED.writeDeny.flatMap((glob) =>
    ["Edit", "Write"].map((tool) => `${tool}(**/${glob})`),
  ),
  ...CLAUDE_SHELL_HOME_DENIES,
  ...HUMAN_ONLY_TOOLS.map(claudeEngineToolName),
];

/** Where the file-path denies of {@link CLAUDE_DENIED_TOOLS} end (its shell denies follow). */
export const CLAUDE_HOME_FILE_DENIES_END: number =
  ROLE_DENIED_VTC.subcommands.length +
  2 * ROLE_DENIED_VTC.homeWriteDeny.length +
  ROLE_DENIED_VTC.homeReadDeny.length +
  1 +
  REPO_ROLE_DENIED.readDeny.length +
  2 * REPO_ROLE_DENIED.writeDeny.length;

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
 * whether Codex merges or replaces the session's entry. A human-only tool never reaches
 * `enabled_tools` (D-an: it throws). Unverified: whether spawned Codex agents honour a per-agent
 * `mcp_servers` table is the spine §7 spike row "Codex per-agent MCP isolation"; until it passes,
 * the engine's Lead-only and human-channel checks (reading 71) are the other barrier on Codex.
 */
export const codexMcpTable = (tools: RoleTools): string[] => {
  const entry = engineMcpServer("codex");
  const engineTools = roleEngineTools(tools);
  return [
    `[mcp_servers.${entry.name}]`,
    `command = ${tomlString(entry.command)}`,
    `args = ${tomlStringArray(entry.args)}`,
    engineTools.length === 0
      ? "enabled = false"
      : `enabled_tools = ${tomlStringArray(engineTools)}`,
  ];
};

/** The table every Codex agent carries: no network for its sandbox (spine §5 reading 79). */
export const CODEX_AGENT_NETWORK_OFF: readonly string[] = [
  "[sandbox_workspace_write]",
  "network_access = false",
];

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
 * covers the rest. Every key is a Codex config key, so whichever way the headless role identity
 * spike loads a role (`codex exec` has no `--agent`), this file carries over as is.
 *
 * Every agent pins `[sandbox_workspace_write] network_access = false` ({@link
 * CODEX_AGENT_NETWORK_OFF}; spine §5 reading 79), so it never inherits a network the user's own
 * Codex config opens: a Codex role can read the VTC install token, and only the network-off
 * sandbox is shown (macOS) to keep it from the engine's socket. A read-only agent has no network
 * either way; the table is there so no agent depends on its mode alone.
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
    ...CODEX_AGENT_NETWORK_OFF,
    "",
    ...codexMcpTable(agent.tools),
    "",
  ].join("\n");
