/**
 * Claude Code sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure, except that a
 * replay trial's `readDeny` paths are resolved through symlinks (no file is read).
 * Read-only roles get read tools only; write-scoped roles get file edits limited to their paths;
 * only the Engineer family gets Bash, and Bash runs inside Claude Code's OS sandbox with no
 * unsandboxed escape. The built-in tool set itself (`--tools`) is exactly the profile's, so no
 * settings file can bring another built-in tool in. Protected paths are denied twice: edit rules
 * and `sandbox.filesystem.denyWrite`. The permission mode is pinned to `dontAsk`, so the
 * allowlist decides and anything not on it is denied; host config files are never writable.
 * The VTC home's install token, daemon sockets and hidden tests (`ROLE_DENIED_VTC.homeReadDeny`,
 * D-an), the Codex home, Claude's own credential file and the user's credential stores
 * (`HOME_CREDENTIAL_LOCATIONS`, as the Lead session and the gate sandbox deny them) are never
 * readable, from a tool or from the shell (D-ad), and neither are a replay trial's
 * `SandboxProfileRequest.readDeny` paths (the user's repo root and git directory, spine §5
 * reading 178; `enforced.readDeny`). No role may run `vtc calibrate` or write anything in
 * `ROLE_DENIED_VTC.homeWriteDeny` or `WAVE3_HOME_WRITE_DENY` (D-w, D-ap, spine §5 reading 103):
 * directories and single files alike. No role may call a human-only engine tool (`approve`,
 * `answer`, `change_request`; D-an) under either of its names, whatever allow rule applies.
 *
 * Settings isolation (AD-25 rule 1, spine §5 reading 108, which replaces reading 48's `project`
 * source and the earlier `--restricted`): a headless run loads `--setting-sources user` only, so
 * the user's own settings (the user's trust domain) apply and the repo's committed or local
 * settings (allow rules, hooks, `env`, MCP enablement: untrusted repo content that `-p` would run
 * without a trust prompt) never do. `--strict-mcp-config` with a VTC-only `--mcp-config` (the
 * engine bridge, `engineMcpServer`) keeps the repo's `.mcp.json` and the user's own MCP servers
 * out. The VTC-authored `--settings` carry the role's sandbox and deny rules; the permission mode
 * is `dontAsk` and `--permission-prompts none`, so nothing ever waits for an answer. The compiled
 * plugin loads from disk (`--plugin-dir`) and the run is its agent (`--agent vtc:<agent>`). Never
 * `--bare` (API-key mode, which never reads the subscription login).
 *
 * Accepted residuals (recorded for spine §7):
 * - The user's own settings apply to role runs: their hooks run, their `permissions.allow` rules
 *   join the profile's allowlist (the profile's `--tools` set and every deny rule still bound
 *   them, and the engine's write-scope check always runs), and their sandbox lists merge with the
 *   profile's. Whether `--restricted` keeps the subscription login and isolates further is the
 *   §7 row "Claude `--restricted`".
 * - Whether the plugin's own MCP server survives `--strict-mcp-config` is the §7 row "Claude
 *   headless plugin agent". The engine tools are allowed under both names (the plugin's
 *   `mcp__plugin_vtc_vtc__*` and the `--mcp-config` server's `mcp__vtc__*`), both the same
 *   engine bridge; `ToolSearch` is in every set in case Claude defers them.
 *
 * Structured output (spine §7, live check 2026-10-14): `--json-schema` answers through the
 * `StructuredOutput` tool, and with `--agent` the session's tools are cut to the agent's own
 * `tools` frontmatter, so the compiled agent lists it too (the compiler's `CLAUDE_SESSION_TOOLS`,
 * with `ToolSearch` and each engine tool under both names); the profile names it in `--tools` and
 * `--allowedTools`. `packages/cli`'s shipped-plugin test checks, for every compiled agent, that
 * each bare tool this profile allows is in the agent's `tools`.
 *
 * Host web tools (H-3, spine §5 reading 156): `WebSearch` and `WebFetch` are in a role's tool set
 * and allowed only when its contract says `host_web`, and denied otherwise; never for a
 * `code_sandboxed` role (refused). They run in Claude Code itself, not in the Bash sandbox, whose
 * network stays as the profile sets it.
 *
 * Nothing here ever sets a bypass; the engine's write-scope check always runs.
 */
import nodePath, { type PlatformPath } from "node:path";
import {
  agentNameFor,
  engineMcpServer,
  HEADLESS_DEFAULTS,
  HEADLESS_ROLE_ENV,
  HOME_CREDENTIAL_LOCATIONS,
  HUMAN_ONLY_TOOLS,
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
import { checkProfileArgs, checkSessionId } from "../common/argv.js";
import {
  canonicalPath,
  ROLE_HOME_WRITE_DENY,
  vtcHomeReadDeniedPaths,
  vtcHomeWriteDeniedPaths,
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

/**
 * The only MCP config a headless role run loads (`--mcp-config` under `--strict-mcp-config`,
 * AD-25 rule 1): the engine bridge, exactly as the plugin declares it (`engineMcpServer`).
 */
export const claudeHeadlessMcpConfig = (): string => {
  const bridge = engineMcpServer(HOST);
  return JSON.stringify({
    mcpServers: { [bridge.name]: { command: bridge.command, args: [...bridge.args] } },
  });
};

/** An engine tool as the `--mcp-config` bridge names it: `mcp__<server>__<tool>`. */
const claudeBridgeToolName = (tool: string): string =>
  `mcp__${engineMcpServer(HOST).name}__${tool}`;

/**
 * Tools that record a human decision (`HUMAN_ONLY_TOOLS`: approve, answer, change_request, D-an,
 * spine §5 reading 71), under both names a role run could reach them by: the plugin's server and
 * the `--mcp-config` bridge. Every profile denies them, in `--disallowedTools` and in the
 * `--settings` deny rules, so no allow rule (the profile's, the agent's or the user's own) can
 * bring one in: the engine cannot tell a role run's bridge from the Lead's by its hello.
 */
export const claudeHumanOnlyToolDenies = (): string[] =>
  HUMAN_ONLY_TOOLS.flatMap((tool) => [claudeEngineToolName(tool), claudeBridgeToolName(tool)]);

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
/**
 * The tool `--json-schema` answers through: the run ends by calling it with the RoleResult, and
 * the `result` event then carries `structured_output`. A session that lacks it never sees the
 * schema, and the model answers in prose (the 2026-10-14 live check: a fenced JSON reply, no
 * `structured_output`). Every role has it; it reaches no file and no network.
 */
export const CLAUDE_STRUCTURED_OUTPUT_TOOL = "StructuredOutput";
const WRITE_TOOL_NAMES = ["Edit", "Write", "NotebookEdit"] as const;
/**
 * The host's own web search and page fetch. A role reaches the web only through engine tools
 * (research fetchers), unless its contract opts in with `host_web` (H-3, spine §5 reading 156:
 * the Research Analyst); never a `code_sandboxed` role.
 */
export const CLAUDE_WEB_TOOLS = ["WebFetch", "WebSearch"] as const;

/** Whether the role has the host's web tools; refused for a role that runs code (H-3). */
const hostWeb = (tools: RoleTools): boolean => {
  if (tools.host_web !== true) return false;
  if (tools.profile === "code_sandboxed") {
    throw new Error(
      "refusing host web tools for a code_sandboxed role: a role that runs code gets no direct web (H-3, spine §5 reading 156)",
    );
  }
  return true;
};

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
const builtInTools = (tools: RoleTools, web: boolean): string[] => [
  ...READ_TOOLS,
  TOOL_SEARCH,
  CLAUDE_STRUCTURED_OUTPUT_TOOL,
  ...(tools.profile === "read_only" ? [] : WRITE_TOOL_NAMES),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...(web ? CLAUDE_WEB_TOOLS : []),
];

const allowedTools = (tools: RoleTools, writable: readonly string[], web: boolean): string[] => [
  ...READ_TOOLS,
  TOOL_SEARCH,
  CLAUDE_STRUCTURED_OUTPUT_TOOL,
  ...(tools.profile === "read_only" ? [] : toolRules(writable, anchoredRulePath)),
  ...(tools.profile === "code_sandboxed" ? ["Bash"] : []),
  ...(web ? CLAUDE_WEB_TOOLS : []),
  ...tools.engine_tools.flatMap((tool) => [claudeEngineToolName(tool), claudeBridgeToolName(tool)]),
];

const disallowedTools = (
  tools: RoleTools,
  protectedPaths: readonly string[],
  web: boolean,
): string[] => [
  ...(tools.profile === "read_only"
    ? [...WRITE_TOOL_NAMES]
    : toolRules([...protectedPaths, ...HOST_CONFIG_PATHS], rulePath)),
  ...(tools.profile === "code_sandboxed" ? [] : ["Bash"]),
  ...(web ? [] : CLAUDE_WEB_TOOLS),
  ...claudeHumanOnlyToolDenies(),
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
   * The user's home, whose credential stores (`HOME_CREDENTIAL_LOCATIONS`: SSH, cloud, registry
   * and git credentials, keychains) no role may read. Only a path for the deny rules: never read.
   * Absent: no home rules (tests that build a profile on another platform).
   */
  readonly homeDir?: string;
  /**
   * The path rules of the platform the role runs on. Default: this platform's (`node:path`);
   * tests pass `path.win32` to build a Windows profile anywhere.
   */
  readonly platformPath?: PlatformPath;
  /**
   * Resolves a `readDeny` path to where it really is (symlinks), so a symlinked spelling (macOS
   * `/var` and `/private/var`) is denied under both names. Default: the real location on this
   * platform (`canonicalPath`), and the path as given under another platform's path rules.
   */
  readonly realPath?: (path: string) => string;
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
 * What no role may read besides the VTC home's `homeReadDeny`, as absolute paths: the whole Codex
 * home and Claude's own credential file.
 */
const unreadablePaths = (
  options: ClaudeProfileOptions,
  platform: PlatformPath,
  shell: boolean,
) => ({
  codexHome: platform.resolve(options.codexHome),
  claudeCredentials: claudeCredentialDeny(options.claudeConfigDir, platform, shell),
  homeCredentials:
    options.homeDir === undefined
      ? []
      : HOME_CREDENTIAL_LOCATIONS.map((rel) => platform.resolve(options.homeDir ?? "", rel)),
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

/** Whether `inner` is `outer` or lies under it, by the platform's path rules (no file is read). */
const covers = (outer: string, inner: string, platform: PlatformPath): boolean => {
  const rel = platform.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !platform.isAbsolute(rel));
};

/** Characters Claude's path rules and sandbox lists read as a pattern, not as themselves. */
const GLOB_CHARS = /[*?[\]{}]/u;

/**
 * `SandboxProfileRequest.readDeny` (spine §5 reading 178), as absolute paths of the platform:
 * each must be absolute, and none may cover the role's worktree or lie inside it (the request
 * never narrows `cwd`), so a wrong request fails here instead of starting a run that cannot read
 * its own files or that reads what it should not. A path with a glob character is refused (it
 * would be read as a pattern, so the real directory might not match and `enforced.readDeny`
 * would claim too much), and a path whose real location differs is denied under both names.
 */
const readDenyPaths = (
  request: SandboxProfileRequest,
  platform: PlatformPath,
  realPath: (path: string) => string,
): string[] => {
  const cwd = platform.resolve(request.cwd);
  const cwds = [...new Set([cwd, realPath(cwd)])];
  const denied = (request.readDeny ?? []).flatMap((path) => {
    if (hasControl(path)) refuseRulePath(path, "paths may not contain control characters");
    if (GLOB_CHARS.test(path)) {
      refuseRulePath(
        path,
        "a readDeny path may not contain glob characters (* ? [ ] { }), which a rule reads as a pattern",
      );
    }
    if (path === "" || !platform.isAbsolute(path)) {
      throw new Error(
        `refusing a Claude role profile: readDeny path ${JSON.stringify(path)} is not absolute`,
      );
    }
    const given = platform.resolve(path);
    const names = [...new Set([given, realPath(given)])];
    for (const name of names) {
      if (GLOB_CHARS.test(name) || hasControl(name)) {
        refuseRulePath(
          name,
          "the real location of a readDeny path may not contain glob characters",
        );
      }
      if (cwds.some((dir) => covers(name, dir, platform) || covers(dir, name, platform))) {
        throw new Error(
          `refusing a Claude role profile: readDeny path ${JSON.stringify(path)} overlaps the role's worktree ${JSON.stringify(request.cwd)}, which readDeny never narrows (spine §5 reading 178)`,
        );
      }
    }
    return names;
  });
  return [...new Set(denied)];
};

export const claudeSandboxProfile = (
  request: SandboxProfileRequest,
  options: ClaudeProfileOptions,
): SandboxProfile => {
  const { tools, cwd } = request;
  const platform = options.platformPath ?? nodePath;
  const writable = tools.profile === "read_only" ? [] : request.writablePaths;
  const web = hostWeb(tools);
  const allow = allowedTools(tools, writable, web);
  const deny = disallowedTools(tools, request.protectedPaths, web);
  const unreadable = unreadablePaths(options, platform, tools.profile === "code_sandboxed");
  const credentials = unreadable.claudeCredentials;
  const readDeny = readDenyPaths(
    request,
    platform,
    options.realPath ?? (platform === nodePath ? canonicalPath : (path: string) => path),
  );
  const vtcHomeRule = absoluteRulePath(options.vtcHome, platform);
  // every rule here is one JSON array entry, so no character in a home path can end a rule
  const settings = {
    permissions: {
      defaultMode: CLAUDE_ROLE_PERMISSION_MODE,
      deny: [
        // the install token, the daemons' sockets and the hidden acceptance tests (D-an, §7.3)
        ...ROLE_DENIED_VTC.homeReadDeny.map((glob) => `Read(${vtcHomeRule}/${glob})`),
        `Read(${absoluteRulePath(unreadable.codexHome, platform)}/**)`,
        credentials.rule,
        // the user's credential stores, a file or a directory each: what the Lead session and the
        // gate sandbox deny too. A host_web role could otherwise be steered by a fetched page
        // into reading one and carrying it out in a WebFetch URL (spine §7 H-3 row)
        ...unreadable.homeCredentials.flatMap((path) => {
          const rule = absoluteRulePath(path, platform);
          return [`Read(${rule})`, `Read(${rule}/**)`];
        }),
        // a replay trial's repo root and git directory (reading 178), a directory or a file each
        ...readDeny.flatMap((path) => {
          const rule = absoluteRulePath(path, platform);
          return [`Read(${rule})`, `Read(${rule}/**)`];
        }),
        ...deniedVtcCommands(),
        // a human decision is never a role's, whatever a user allow rule says (D-an)
        ...claudeHumanOnlyToolDenies(),
        ...ROLE_HOME_WRITE_DENY.flatMap((glob) =>
          WRITE_TOOL_NAMES.map((tool) => `${tool}(${vtcHomeRule}/${glob})`),
        ),
      ],
    },
    sandbox: {
      enabled: true,
      // without it a sandbox that cannot start (Linux/WSL without bubblewrap or socat, an
      // unsupported platform) runs Bash unsandboxed: the run exits with an error instead
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: tools.profile === "code_sandboxed",
      allowUnsandboxedCommands: false,
      filesystem: {
        denyWrite: [
          ...[...request.protectedPaths, ...HOST_CONFIG_PATHS].map((p) =>
            absolute(cwd, p, platform),
          ),
          // directories and single files (`config.yaml`, `token`) alike (D-ap)
          ...vtcHomeWriteDeniedPaths(options.vtcHome, platform),
        ],
        denyRead: [
          ...vtcHomeReadDeniedPaths(options.vtcHome, platform),
          unreadable.codexHome,
          ...(credentials.sandboxPath === undefined ? [] : [credentials.sandboxPath]),
          ...unreadable.homeCredentials,
          ...readDeny,
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
      // every `readDeny` path, from the tools and from the shell, as above (reading 178)
      readDeny: true,
    },
    settings,
    cliArgs: [
      "--settings",
      JSON.stringify(settings),
      "--tools",
      builtInTools(tools, web).join(","),
      "--allowedTools",
      allow.join(","),
      "--disallowedTools",
      deny.join(","),
    ],
  };
};

/** The flags a Claude sandbox profile passes on the command line, each with one value. */
const CLAUDE_PROFILE_FLAGS = ["--settings", "--tools", "--allowedTools", "--disallowedTools"];

export interface ClaudeCommandOptions {
  /**
   * The compiled Claude plugin on disk (the cli's extracted `plugin:claude-code`). Every headless
   * run loads the plugin from it (`--plugin-dir`), so the role is the compiled agent with its
   * prompt SHA in any worktree whatever the install scope, and the repo's settings and MCP servers
   * stay out (AD-25 rule 1). Without it there is no isolated run, so `claudeHeadlessCommand`
   * refuses to build one (fail closed).
   */
  readonly pluginDir?: string;
}

/**
 * Where a replay arm's run writes its debug log (D-cg): beside the arm directory, never inside it,
 * because the host loads the arm in place and it must stay unchanged until the run exits
 * (`<arms>/<trial>/<arm>` → `<arms>/<trial>/<arm>.debug.log`, in the engine's guard directory,
 * which roles cannot write but can read). The adapter removes it before the run starts and again
 * once the run has ended and the load proof has read it (`index.ts`).
 */
export const claudeArmDebugFile = (armDir: string): string =>
  nodePath.join(nodePath.dirname(armDir), `${nodePath.basename(armDir)}.debug.log`);

/** The arm directory of a replay run, checked: absolute, and not a filesystem root. */
const armDirOf = (request: SpawnRoleRequest): string | undefined => {
  const dir = request.pluginDir;
  if (dir === undefined) return undefined;
  if (!nodePath.isAbsolute(dir) || nodePath.basename(dir) === "" || hasControl(dir)) {
    throw new Error(
      `refusing a headless Claude replay run: its plugin directory ${JSON.stringify(dir)} must be an absolute directory path (D-cg)`,
    );
  }
  return dir;
};

/**
 * `claude -p` for a role (fresh, or `--resume <id>`). The stream is `stream-json` so the engine
 * sees SDK rate-limit and retry events as they happen (§6.9); the final `result` event carries
 * `structured_output` for `--json-schema` once the run has called `StructuredOutput` (spike 1;
 * live check 2026-10-14, which also needs the tool in the agent's own `tools`, as the
 * compiler emits it). The run is the role's compiled plugin agent (`--agent vtc:<agent>`), so
 * it gets the role's instructions and tool list. The prompt is read from stdin (the launcher
 * writes it and closes stdin), so it never sits in argv. The
 * environment sets `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` explicitly, so a run never waits the
 * host's default 10 minutes for background work after its result (AD-25 rule 4).
 *
 * A Lookback replay arm (D-cg, spine §5 reading 201): `request.pluginDir` replaces the adapter's
 * plugin directory for this run only, and the run writes its debug log beside the arm
 * (`--debug-file`, {@link claudeArmDebugFile}), so `HeadlessRun.pluginLoad` can prove the arm's
 * copy loaded: a plugin locked by managed settings keeps the installed copy and says so only in
 * that log. Everything else, the isolation flags and the profile, is as for any role run, and no
 * bypass flag is ever added (AD-25).
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
  // only what `claudeSandboxProfile` emits: never a second isolation flag that would win (AD-25)
  checkProfileArgs(HOST, request.sandbox.cliArgs, CLAUDE_PROFILE_FLAGS);
  if (session !== undefined) checkSessionId(HOST, session.id);
  const armDir = armDirOf(request);
  const pluginDir = armDir ?? options.pluginDir;
  if (pluginDir === undefined) {
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
      // the user's settings only: the repo's committed and local settings (allow rules, hooks,
      // env, MCP enablement) are untrusted repo content (AD-25 rule 1, reading 108)
      "--setting-sources",
      "user",
      // no MCP server but the engine bridge: not the repo's .mcp.json, not the user's servers
      "--strict-mcp-config",
      "--mcp-config",
      claudeHeadlessMcpConfig(),
      "--plugin-dir",
      pluginDir,
      // a replay arm's proof of which copy loaded (D-cg)
      ...(armDir === undefined ? [] : ["--debug-file", claudeArmDebugFile(armDir)]),
      ...request.sandbox.cliArgs,
    ],
    env: {
      CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: String(HEADLESS_DEFAULTS.claudeBackgroundWaitMs),
      // hook contract rule 7 (5.5.0): the plugin's hooks run here too, and this marks the
      // session as an engine-launched role run whatever the hook input carries
      [HEADLESS_ROLE_ENV]: claudeSubagentName(agentNameFor(request.role, request.mode)),
    },
  };
};
