/**
 * Claude Code sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure.
 * Read-only roles get read tools only; write-scoped roles get file edits limited to their paths;
 * only the Engineer family gets Bash, and Bash runs inside Claude Code's OS sandbox with no
 * unsandboxed escape. The built-in tool set itself (`--tools`) is exactly the profile's, so no
 * settings file can bring another built-in tool in. Protected paths are denied twice: edit rules
 * and `sandbox.filesystem.denyWrite`. The permission mode is pinned to `dontAsk`, so the
 * allowlist decides and anything not on it is denied; host config files are never writable.
 * The VTC install token, the Codex home and Claude's own credential file are never readable,
 * from a tool or from the shell (D-ad). No role may run `vtc calibrate` or write the VTC home's
 * allowlists, scanner database or hidden tests (D-w).
 *
 * Settings isolation (D-ab, spine §5 reading 48): a headless run passes `--restricted`, which
 * (per `claude --help`) ignores the user, project and local settings files and keeps only
 * managed settings and the VTC-authored `--settings`. So neither the user's settings nor a
 * committed `.claude/settings.json` (allow rules, hooks, MCP enablement) reach a role run. It
 * also confines the file tools to the working directory. The compiled plugin loads from disk
 * (`--plugin-dir`). What the spike still has to confirm (spine §7, "Claude settings-source
 * isolation"): that `--plugin-dir`, `--agent vtc:<agent>`, the plugin's hooks and its MCP server
 * load under `--restricted`, and that the engine MCP tools are callable in a `--restricted
 * --tools <set>` run (`ToolSearch` is in every set in case Claude defers them).
 *
 * Accepted residuals until that spike (recorded for spine §7, reading 48):
 * - MCP servers from the user's `~/.claude.json` (not a settings file) still start, as host
 *   processes outside the role sandbox, and their server instructions reach the role's context;
 *   their tools are denied (not on the allowlist under `dontAsk`). `--strict-mcp-config` would
 *   stop them but is not passed: it may also drop the plugin's own MCP server, which carries
 *   every engine tool. The spike checks whether the plugin server survives it.
 * - `--restricted` confines the file tools to the working directory and no `--add-dir` is
 *   passed, so a headless QA-author run could not write its hidden-test staging scope in the
 *   main checkout (spine §5 reading 65). QA author must stay on subagent dispatch until a
 *   profile request can name a main-checkout scope.
 * - `--restricted` lets only a person or a permission handler approve writes to settings, git
 *   and tool-configuration files, and `--permission-prompts none` answers nobody, so an
 *   Engineer's in-scope write to such a file (a package's `tsconfig.json`) may be denied.
 *
 * Nothing here ever sets a bypass; the engine's write-scope check always runs.
 */
import nodePath, { type PlatformPath } from "node:path";
import {
  agentNameFor,
  ENGINE_INSTANCE,
  hostCredentialDenyReadPaths,
  isHostCredentialDenyRead,
  ROLE_DENIED_VTC,
  type HostCommand,
  type RoleTools,
  type SandboxProfile,
  type SandboxProfileRequest,
  type SessionRef,
  type SpawnRoleRequest,
} from "@vtc/shared";
import {
  VTC_HOME_READ_DENIED_DIRS,
  vtcHomeReadDeniedDirs,
  vtcHomeWriteDeniedDirs,
} from "../common/homes.js";

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
/**
 * Loads the definitions of deferred tools. Claude Code may defer MCP tools when their
 * definitions are large, and then the engine's own tools (submit, ask) need it to be callable at
 * all. It reaches no file and no network.
 */
const TOOL_SEARCH = "ToolSearch";
const WRITE_TOOL_NAMES = ["Edit", "Write", "NotebookEdit"] as const;
/** Roles reach the web only through engine tools (research fetchers), never directly. */
const WEB_TOOLS = ["WebFetch", "WebSearch"] as const;

/** Host config a role must never change: it would load into later runs in the same worktree. */
export const HOST_CONFIG_PATHS = [".claude/**", ".mcp.json", ".codex/**"] as const;

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

const refuseRulePath = (path: string, why: string): never => {
  throw new Error(`refusing the path ${JSON.stringify(path)} in a Claude permission rule: ${why}`);
};

/**
 * A repo-relative path as a Claude rule path. Claude reads a leading `~` as the user's home and a
 * leading `/` as an anchor outside the working directory, so both are refused; what is left is
 * relative to the role's worktree.
 */
const rulePath = (path: string): string => {
  if (path === "" || UNSAFE_RULE_PATH.test(path) || hasControl(path)) {
    refuseRulePath(
      path,
      "paths may not contain parentheses, commas, quotes, spaces or control characters",
    );
  }
  if (path.startsWith("~") || path.startsWith("/")) {
    refuseRulePath(path, "paths must be relative to the worktree (no leading `~` or `/`)");
  }
  return path;
};

/** Allow rules are anchored to the worktree (`./`), so no other prefix syntax can apply. */
const anchoredRulePath = (path: string): string => {
  const checked = rulePath(path);
  return checked.startsWith("./") ? checked : `./${checked}`;
};

const toolRules = (paths: readonly string[], rule: (path: string) => string): string[] =>
  paths.flatMap((path) => WRITE_TOOL_NAMES.map((tool) => `${tool}(${rule(path)})`));

/** An absolute path of the given platform, with `/` separators. */
const posixAbsolute = (path: string, platform: PlatformPath): string =>
  platform.resolve(path).replaceAll("\\", "/");

/**
 * An absolute path in Claude's rule form (`//abs/path`; Windows `C:\x` as `//c/x`). These rules go
 * into the `--settings` JSON, one array entry each, so no character in the path can end a rule.
 */
const absoluteRulePath = (path: string, platform: PlatformPath): string => {
  if (hasControl(path)) refuseRulePath(path, "paths may not contain control characters");
  const posix = posixAbsolute(path, platform);
  const drive = /^(?<letter>[A-Za-z]):(?<rest>\/.*)?$/u.exec(posix)?.groups;
  if (drive === undefined) return `/${posix}`;
  return `//${(drive.letter ?? "").toLowerCase()}${drive.rest ?? "/"}`;
};

/** The built-in tools a profile has at all (`--tools`); anything else does not exist in the run. */
const builtInTools = (tools: RoleTools): string[] => [
  ...READ_TOOLS,
  TOOL_SEARCH,
  ...(tools.profile === "read_only" ? [] : WRITE_TOOL_NAMES),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
];

const allowedTools = (tools: RoleTools, writable: readonly string[]): string[] => [
  ...READ_TOOLS,
  TOOL_SEARCH,
  ...(tools.profile === "read_only" ? [] : toolRules(writable, anchoredRulePath)),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...tools.engine_tools.map(claudeEngineToolName),
];

const disallowedTools = (tools: RoleTools, protectedPaths: readonly string[]): string[] => [
  ...(tools.profile === "read_only"
    ? [...WRITE_TOOL_NAMES]
    : toolRules([...protectedPaths, ...HOST_CONFIG_PATHS], rulePath)),
  ...(tools.profile === "code_sandboxed" ? [] : ["Bash"]),
  ...WEB_TOOLS,
];

const absolute = (cwd: string, path: string, platform: PlatformPath): string =>
  platform.isAbsolute(path) ? path : platform.join(cwd, path);

/** The permission mode of every role run: the allowlist decides, nothing is ever asked. */
export const CLAUDE_ROLE_PERMISSION_MODE = "dontAsk";

export interface ClaudeProfileOptions {
  /** The absolute VTC home (`~/.vtc`, or `$VTC_HOME`), where the install token lives (AD-5). */
  readonly vtcHome: string;
  /** The absolute Codex home (`~/.codex`, or `$CODEX_HOME`): Codex's config and credentials. */
  readonly codexHome: string;
  /** Claude's own config directory (`$CLAUDE_CONFIG_DIR`, or `~/.claude`), never read here. */
  readonly claudeConfigDir: string;
  /**
   * The path rules of the platform the role runs on. Default: this platform's (`node:path`);
   * tests pass `path.win32` to build a Windows profile anywhere.
   */
  readonly platformPath?: PlatformPath;
}

/** `C:/…`: a Windows drive path, after `posixAbsolute`. */
const DRIVE_PATH = /^[A-Za-z]:\//u;

/**
 * How a role is kept from reading Claude's credential file: a `Read(...)` deny rule for the file
 * tools, and the bare path for the sandbox's `denyRead`, which is what a shell meets.
 */
interface CredentialDeny {
  readonly rule: string;
  /** Absent when the sandbox list cannot carry the path; then no shell role is built. */
  readonly sandboxPath?: string;
}

/**
 * Claude's credential file, built only through the shared deny helper (D-ad): path strings for
 * the deny lists, never opened. Refused when an entry could name anything else (wildcards,
 * brackets, commas), because then it would not be the sanctioned deny-only form (AD-9).
 *
 * Windows: the AD-9 exemption (`isHostCredentialDenyRead`) accepts the rule form (`//c/…`) but
 * not yet a bare drive path (`C:/…`), so the sandbox list cannot name the file there. The file
 * tools are still denied by the rule; a shell role is refused, explicitly, until the shared
 * exemption accepts drive paths (contract proposal from the adapters team).
 */
const claudeCredentialDeny = (
  configDir: string,
  platform: PlatformPath,
  shell: boolean,
): CredentialDeny => {
  const paths = hostCredentialDenyReadPaths({
    "claude-code": posixAbsolute(configDir, platform),
  });
  const [path] = paths;
  if (path === undefined || paths.length !== 1) {
    throw new Error("expected exactly one Claude credential file to deny");
  }
  const rule = `Read(${absoluteRulePath(path, platform)})`;
  const bareAllowed = isHostCredentialDenyRead(path);
  if (!isHostCredentialDenyRead(rule) || (!bareAllowed && !DRIVE_PATH.test(path))) {
    throw new Error(
      `refusing a Claude role profile: cannot deny reading the credential file in ${JSON.stringify(configDir)} with a rule that names only that file`,
    );
  }
  if (bareAllowed) return { rule, sandboxPath: path };
  if (shell) {
    throw new Error(
      `refusing a Claude shell role with its config directory on a Windows drive path (${JSON.stringify(configDir)}): the sandbox cannot yet deny reading the credential file there, because the shared AD-9 deny-list exemption does not accept drive paths (contract proposal pending); read-only and write-scoped roles still run`,
    );
  }
  return { rule };
};

/**
 * What no role may read, as absolute paths: the install token, the whole Codex home and Claude's
 * own credential file.
 */
const unreadablePaths = (
  options: ClaudeProfileOptions,
  platform: PlatformPath,
  shell: boolean,
) => ({
  token: platform.resolve(options.vtcHome, ENGINE_INSTANCE.tokenFile),
  codexHome: platform.resolve(options.codexHome),
  claudeCredentials: claudeCredentialDeny(options.claudeConfigDir, platform, shell),
});

/**
 * How a role could start `vtc`: directly or through a package runner. Bash rules match a
 * command's prefix, so these are a first line; the barrier for what `vtc calibrate` protects is
 * the sandbox's write deny on the VTC home (below), and calibrate confirms only in a terminal.
 */
const VTC_LAUNCHERS = ["", "npx ", "pnpm ", "pnpm exec ", "pnpm dlx ", "bunx ", "yarn "] as const;

/** D-w: `Bash(...)` deny rules for every `vtc` subcommand no role may run. */
const deniedVtcCommands = (): string[] =>
  ROLE_DENIED_VTC.subcommands.flatMap((sub) =>
    VTC_LAUNCHERS.flatMap((launcher) => [
      `Bash(${launcher}vtc ${sub})`,
      `Bash(${launcher}vtc ${sub}:*)`,
    ]),
  );

export const claudeSandboxProfile = (
  request: SandboxProfileRequest,
  options: ClaudeProfileOptions,
): SandboxProfile => {
  const { tools, cwd } = request;
  const platform = options.platformPath ?? nodePath;
  const writable = tools.profile === "read_only" ? [] : request.writablePaths;
  const allow = allowedTools(tools, writable);
  const deny = disallowedTools(tools, request.protectedPaths);
  const unreadable = unreadablePaths(options, platform, tools.profile === "code_sandboxed");
  const credentials = unreadable.claudeCredentials;
  const vtcHomeRule = absoluteRulePath(options.vtcHome, platform);
  // every rule here is one JSON array entry, so no character in a home path can end a rule
  const settings = {
    permissions: {
      defaultMode: CLAUDE_ROLE_PERMISSION_MODE,
      deny: [
        `Read(${absoluteRulePath(unreadable.token, platform)})`,
        `Read(${absoluteRulePath(unreadable.codexHome, platform)}/**)`,
        credentials.rule,
        // the hidden acceptance tests and the daemons' sockets (§7.3; spine §7 residual)
        ...VTC_HOME_READ_DENIED_DIRS.map((dir) => `Read(${vtcHomeRule}/${dir}/**)`),
        ...deniedVtcCommands(),
        ...ROLE_DENIED_VTC.homeWriteDeny.flatMap((glob) =>
          WRITE_TOOL_NAMES.map((tool) => `${tool}(${vtcHomeRule}/${glob})`),
        ),
      ],
    },
    sandbox: {
      enabled: true,
      autoAllowBashIfSandboxed: tools.profile === "code_sandboxed",
      allowUnsandboxedCommands: false,
      filesystem: {
        denyWrite: [
          ...[...request.protectedPaths, ...HOST_CONFIG_PATHS].map((p) =>
            absolute(cwd, p, platform),
          ),
          ...vtcHomeWriteDeniedDirs(options.vtcHome, platform),
        ],
        denyRead: [
          unreadable.token,
          unreadable.codexHome,
          ...(credentials.sandboxPath === undefined ? [] : [credentials.sandboxPath]),
          ...vtcHomeReadDeniedDirs(options.vtcHome, platform),
        ],
      },
      network: { allowedDomains: request.network === "registries" ? [...REGISTRY_DOMAINS] : [] },
    },
  };
  return {
    host: HOST,
    enforced: {
      readOnly: tools.profile === "read_only",
      perPathWriteDeny: true,
      network: true,
      // read-deny rules plus `sandbox.filesystem.denyRead` (D-ad, spine §5 reading 49); a role
      // whose sandbox list cannot name the credential file has no shell (Windows, above)
      secretsUnreadable: true,
    },
    settings,
    cliArgs: [
      "--settings",
      JSON.stringify(settings),
      "--tools",
      builtInTools(tools).join(","),
      "--allowedTools",
      allow.join(","),
      "--disallowedTools",
      deny.join(","),
    ],
  };
};

export interface ClaudeCommandOptions {
  /**
   * The compiled Claude plugin on disk (the cli's extracted `plugin:claude-code`). Every headless
   * run loads the plugin from it (`--plugin-dir`) and no settings file (`--restricted`): the
   * user's and the repo's settings, plugins and hooks cannot widen a role run, and the plugin
   * resolves in any worktree whatever the install scope. Without it there is no isolated run, so
   * `claudeHeadlessCommand` refuses to build one (fail closed).
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
  if (options.pluginDir === undefined) {
    throw new Error(
      "refusing a headless Claude role run without the compiled plugin on disk: pass `pluginDir` to the adapter so the run loads it isolated from the user's settings",
    );
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
      // no resolved id (D-ae): the session's default model runs, only the effort is set
      ...(request.model.model === undefined ? [] : ["--model", request.model.model]),
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
      // no settings file (user, project or local: allow rules, hooks, MCP enablement) reaches a
      // role run; only managed settings and the VTC-authored --settings apply (D-ab)
      "--restricted",
      "--plugin-dir",
      options.pluginDir,
      ...request.sandbox.cliArgs,
    ],
    env: {},
  };
};
