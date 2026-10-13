/**
 * Claude Code sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure.
 * Read-only roles get read tools only; write-scoped roles get file edits limited to their paths;
 * only the Engineer family gets Bash, and Bash runs inside Claude Code's OS sandbox with no
 * unsandboxed escape. Protected paths are denied twice: edit rules and `sandbox.filesystem.denyWrite`.
 * The permission mode is pinned to `dontAsk`, so the allowlist decides and anything not on it is
 * denied, whatever mode the user's own settings choose; host config files are never writable and
 * the VTC install token is never readable. Nothing here ever sets a bypass; the engine's
 * write-scope check always runs.
 */
import { isAbsolute, join } from "node:path";
import {
  agentNameFor,
  ENGINE_INSTANCE,
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
/** Roles reach the web only through engine tools (research fetchers), never directly. */
const WEB_TOOLS = ["WebFetch", "WebSearch"] as const;

/** Host config a role must never change: it would load into later runs in the same worktree. */
export const HOST_CONFIG_PATHS = [".claude/**", ".mcp.json", ".codex/**"] as const;

/** The VTC install token (AD-5 rule 2), as a Claude permission-rule path. */
const TOKEN_RULE_PATH = `~/.vtc/${ENGINE_INSTANCE.tokenFile}`;

/**
 * Characters that would end a permission rule or start another in Claude's rule lists (comma or
 * space separated, `Tool(path)`), plus quotes and control characters. Write scopes come partly
 * from LLM-authored `files_scope`, so a path carrying them is refused, never escaped.
 */
const UNSAFE_RULE_PATH = /[(),"'`\s\\]/u;
const hasControl = (path: string): boolean => {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
};

const rulePath = (path: string): string => {
  if (path === "" || UNSAFE_RULE_PATH.test(path) || hasControl(path)) {
    throw new Error(
      `refusing the path ${JSON.stringify(path)} in a Claude permission rule: paths may not contain parentheses, commas, quotes, spaces or control characters`,
    );
  }
  return path;
};

const pathRules = (paths: readonly string[]): string[] =>
  paths.flatMap((path) => WRITE_TOOL_NAMES.map((tool) => `${tool}(${rulePath(path)})`));

const allowedTools = (tools: RoleTools, writable: readonly string[]): string[] => [
  ...READ_TOOLS,
  ...(tools.profile === "read_only" ? [] : pathRules(writable)),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...tools.engine_tools.map(claudeEngineToolName),
];

const disallowedTools = (tools: RoleTools, protectedPaths: readonly string[]): string[] => [
  ...(tools.profile === "read_only"
    ? [...WRITE_TOOL_NAMES]
    : pathRules([...protectedPaths, ...HOST_CONFIG_PATHS])),
  ...(tools.profile === "code_sandboxed" ? [] : ["Bash"]),
  ...WEB_TOOLS,
  `Read(${TOKEN_RULE_PATH})`,
];

const absolute = (cwd: string, path: string): string => (isAbsolute(path) ? path : join(cwd, path));

/** The permission mode of every role run: the allowlist decides, nothing is ever asked. */
export const CLAUDE_ROLE_PERMISSION_MODE = "dontAsk";

export interface ClaudeProfileOptions {
  /** The user's home, where the VTC home (`~/.vtc`) and its install token live. */
  readonly home: string;
}

export const claudeSandboxProfile = (
  request: SandboxProfileRequest,
  options: ClaudeProfileOptions,
): SandboxProfile => {
  const { tools, cwd } = request;
  const writable = tools.profile === "read_only" ? [] : request.writablePaths;
  const allow = allowedTools(tools, writable);
  const deny = disallowedTools(tools, request.protectedPaths);
  const settings = {
    permissions: { defaultMode: CLAUDE_ROLE_PERMISSION_MODE },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: tools.profile === "code_sandboxed",
      allowUnsandboxedCommands: false,
      filesystem: {
        denyWrite: [...request.protectedPaths, ...HOST_CONFIG_PATHS].map((p) => absolute(cwd, p)),
        denyRead: [join(options.home, ".vtc", ENGINE_INSTANCE.tokenFile)],
      },
      network: { allowedDomains: request.network === "registries" ? [...REGISTRY_DOMAINS] : [] },
    },
  };
  return {
    host: HOST,
    enforced: { readOnly: tools.profile === "read_only", perPathWriteDeny: true, network: true },
    settings,
    cliArgs: [
      "--settings",
      JSON.stringify(settings),
      "--allowedTools",
      allow.join(","),
      "--disallowedTools",
      deny.join(","),
    ],
  };
};

export interface ClaudeCommandOptions {
  /**
   * The compiled Claude plugin on disk (the cli's extracted `plugin:claude-code`). When given, a
   * run loads the plugin from it (`--plugin-dir`) and reads only the repo's project settings
   * (`--setting-sources project`): the user's own settings, plugins and hooks cannot widen a role
   * run, and the plugin resolves in any worktree whatever the install scope. Without it the run
   * relies on the installed plugin and the user's settings (the pinned mode and explicit denies
   * still apply).
   */
  readonly pluginDir?: string;
}

/**
 * `claude -p` for a role (fresh, or `--resume <id>`). The stream is `stream-json` so the engine
 * sees SDK rate-limit and retry events as they happen (§6.9); the final `result` event carries
 * `structured_output` for `--json-schema` (spike 1). The run is the role's compiled plugin agent
 * (`--agent vtc:<agent>`), so it gets the role's instructions and tool list. The prompt is read
 * from stdin (the launcher writes it and closes stdin), so it never sits in argv.
 */
export const claudeHeadlessCommand = (
  request: SpawnRoleRequest,
  session?: SessionRef,
  options: ClaudeCommandOptions = {},
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
      // the allowlist decides whatever mode the user's settings choose, and nobody is ever asked
      "--permission-mode",
      CLAUDE_ROLE_PERMISSION_MODE,
      "--permission-prompts",
      "none",
      ...(request.maxTurns === undefined ? [] : ["--max-turns", String(request.maxTurns)]),
      ...(request.maxBudgetUsd === undefined
        ? []
        : ["--max-budget-usd", String(request.maxBudgetUsd)]),
      ...(session === undefined ? [] : ["--resume", session.id]),
      ...(options.pluginDir === undefined
        ? []
        : ["--setting-sources", "project", "--plugin-dir", options.pluginDir]),
      ...request.sandbox.cliArgs,
    ],
    env: {},
  };
};
