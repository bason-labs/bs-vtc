/**
 * Claude Code sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure.
 * Read-only roles get read tools only; write-scoped roles get file edits limited to their paths;
 * only the Engineer family gets Bash, and Bash runs inside Claude Code's OS sandbox with no
 * unsandboxed escape. Protected paths are denied twice: edit rules and `sandbox.filesystem.denyWrite`.
 * Nothing here ever sets a permission mode or a bypass; the engine's write-scope check always runs.
 */
import { isAbsolute, join } from "node:path";
import {
  agentNameFor,
  type HostCommand,
  type RoleTools,
  type SandboxProfile,
  type SandboxProfileRequest,
  type SessionRef,
  type SpawnRoleRequest,
} from "@vtc/shared";

export const CLAUDE_BINARY = "claude";
export const HOST = "claude-code";

/** The plugin's name, which Claude Code puts in front of plugin agents (AD-14 rule 1). */
export const CLAUDE_PLUGIN_NAMESPACE = "vtc";

/** `vtc:<agent>`: the name a plugin agent spawns under (provisional until the spike, spine §7). */
export const claudeSubagentName = (agent: string): string => `${CLAUDE_PLUGIN_NAMESPACE}:${agent}`;

/** Claude Code names plugin MCP tools `mcp__plugin_<plugin>_<server>__<tool>`. */
export const claudeEngineToolName = (tool: string): string =>
  `mcp__plugin_${CLAUDE_PLUGIN_NAMESPACE}_vtc__${tool}`;

/** Package registries the install phase may reach (§7.2); everything else has no network. */
export const REGISTRY_DOMAINS = [
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "repo.maven.apache.org",
] as const;

const READ_TOOLS = ["Read", "Grep", "Glob"] as const;
const WRITE_TOOL_NAMES = ["Edit", "Write", "NotebookEdit"] as const;

const pathRules = (paths: readonly string[]): string[] =>
  paths.flatMap((path) => WRITE_TOOL_NAMES.map((tool) => `${tool}(${path})`));

const allowedTools = (tools: RoleTools, writable: readonly string[]): string[] => [
  ...READ_TOOLS,
  ...(tools.profile === "read_only" ? [] : pathRules(writable)),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...tools.engine_tools.map(claudeEngineToolName),
];

const disallowedTools = (tools: RoleTools, protectedPaths: readonly string[]): string[] => [
  ...(tools.profile === "read_only" ? [...WRITE_TOOL_NAMES] : pathRules(protectedPaths)),
  ...(tools.profile === "code_sandboxed" ? [] : ["Bash"]),
];

const absolute = (cwd: string, path: string): string => (isAbsolute(path) ? path : join(cwd, path));

export const claudeSandboxProfile = (request: SandboxProfileRequest): SandboxProfile => {
  const { tools, cwd } = request;
  const writable = tools.profile === "read_only" ? [] : request.writablePaths;
  const settings = {
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: tools.profile === "code_sandboxed",
      allowUnsandboxedCommands: false,
      filesystem: { denyWrite: request.protectedPaths.map((p) => absolute(cwd, p)) },
      network: { allowedDomains: request.network === "registries" ? [...REGISTRY_DOMAINS] : [] },
    },
  };
  const allow = allowedTools(tools, writable);
  const deny = disallowedTools(tools, request.protectedPaths);
  return {
    host: HOST,
    enforced: { readOnly: tools.profile === "read_only", perPathWriteDeny: true, network: true },
    settings,
    cliArgs: [
      "--settings",
      JSON.stringify(settings),
      "--allowedTools",
      allow.join(","),
      ...(deny.length === 0 ? [] : ["--disallowedTools", deny.join(",")]),
    ],
  };
};

/**
 * `claude -p` for a role (fresh, or `--resume <id>`). The stream is `stream-json` so the engine
 * sees SDK rate-limit and retry events as they happen (§6.9); the final `result` event carries
 * `structured_output` for `--json-schema` (spike 1). The run is the role's compiled plugin agent
 * (`--agent vtc:<agent>`), so it gets the role's instructions and tool list. The prompt goes
 * after `--` so no prompt text is read as an option.
 */
export const claudeHeadlessCommand = (
  request: SpawnRoleRequest,
  session?: SessionRef,
): HostCommand => {
  if (request.sandbox.host !== HOST) {
    throw new Error(`a ${request.sandbox.host} sandbox profile cannot run on ${HOST}`);
  }
  if (session !== undefined && session.host !== HOST) {
    throw new Error(`cannot resume a ${session.host} session on ${HOST}`);
  }
  return {
    command: CLAUDE_BINARY,
    args: [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(request.outputSchema),
      "--agent",
      claudeSubagentName(agentNameFor(request.role, request.mode)),
      "--model",
      request.model.model,
      "--effort",
      request.model.effort,
      // nobody answers a prompt in a headless run: anything not allowed is denied, never asked
      "--permission-prompts",
      "none",
      ...(request.maxTurns === undefined ? [] : ["--max-turns", String(request.maxTurns)]),
      ...(request.maxBudgetUsd === undefined
        ? []
        : ["--max-budget-usd", String(request.maxBudgetUsd)]),
      ...(session === undefined ? [] : ["--resume", session.id]),
      ...request.sandbox.cliArgs,
      "--",
      request.prompt,
    ],
    env: {},
  };
};
