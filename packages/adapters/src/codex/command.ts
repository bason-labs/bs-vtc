/**
 * Codex sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure, except that the
 * VTC-home overlap check resolves symlinks in the paths it compares (no file is read).
 * Reviewers run in the `read-only` sandbox; write-scoped roles and engineers in `workspace-write`
 * (writes limited to the worktree, never any network). Codex has no per-path write-deny, so the
 * engine's write-scope check is the only path enforcement (§12.1). Every sandbox key a profile
 * relies on is set explicitly on the command line, so the user's `config.toml` cannot widen it
 * (network access, extra writable roots). Nothing here ever names a full-access sandbox or a
 * bypass.
 *
 * The registry network (§7.2) is refused for every role (D-ac, spine §5 reading 49): Codex can
 * only open the whole network, and Codex sandboxes allow reads everywhere, so a role could read
 * the VTC install token and the host credentials and use the token against the engine's
 * localhost API. Dependency installs are an engine-run step, never a role action.
 *
 * Known gaps, recorded for the engine (and in the tests):
 * - Codex sandboxes allow reads everywhere, so a role process can read the VTC install token and
 *   the host credential files; there is no per-path read deny to set (D-ad), so
 *   `enforced.secretsUnreadable` is false. With the network always off the process cannot send
 *   them anywhere, but it can copy them into its output or worktree.
 * - The role deny list (D-w): Codex has no per-command deny for a headless run, so `vtc
 *   calibrate` cannot be denied here (it confirms only in an interactive terminal, which a role
 *   run never has). Writes to everything in `ROLE_HOME_WRITE_DENY` (`ROLE_DENIED_VTC
 *   .homeWriteDeny` plus `WAVE3_HOME_WRITE_DENY`, through `vtcHomeWriteDeniedPaths`; D-w, D-ap,
 *   spine §5 reading 103: the allowlists, scanner database and binaries, hidden tests, plugin
 *   copies, discovery files and sockets, `config.yaml`, the token, and the wave-3 Lookback,
 *   research, browser and design directories) are blocked because `workspace-write` writes only the
 *   worktree and the OS temp roots (`$TMPDIR`, `/tmp`; D-ag lets roles write there). So a profile
 *   whose worktree overlaps one of those paths is refused, and when one lies under a temp root (a VTC home in the temp
 *   directory, as in test setups) the profile takes both temp roots out of the writable set
 *   (`exclude_tmpdir_env_var`, `exclude_slash_tmp`). Paths compare by real location, so a
 *   symlinked worktree or VTC home cannot hide an overlap.
 * - The VTC home's `homeReadDeny` (D-an: the token, the sockets in `run/`, the hidden tests) is
 *   readable too, for the same reason. If a role could also connect to a socket in `run/`, it
 *   could send a cli hello with the token it read, and the token is the cli's proof of a human
 *   for `approve`/`answer`/`change_request` (D-an). So `enforced.network` claims more than "no
 *   TCP": it is true only on a platform where the network-off sandbox is shown to block a
 *   path-based Unix-socket connect too ({@link CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS}). On macOS
 *   it is: under codex-cli 0.162.1 seatbelt, `sandbox_mode` `read-only` and `workspace-write`
 *   with `network_access=false` both fail a `connect()` to a listening Unix socket with `EPERM`,
 *   while `network_access=true` lets it through (checked 2026-10-14 with `codex sandbox` and a
 *   temp `CODEX_HOME`). Elsewhere it is not shown (Linux: a network namespace alone does not
 *   hide a socket path visible in the mount namespace, and bwrap/landlock behaviour is
 *   unchecked), so the profile reports `enforced.network: false` and the engine's
 *   `roleSandboxProblem` refuses the run (fail closed) until the spine §7 item for Codex roles
 *   (token readable; Unix-socket connect under the network-off sandbox, per platform) passes
 *   on that platform.
 * - Host config in the worktree (D-ao, spine §5 reading 72): every role run passes
 *   `-c notify=[]`, so no `notify` command (user or role-planted) runs outside the sandbox, and
 *   `--ignore-rules` (on `codex exec` and `codex exec resume`, 0.162.1), so no execpolicy
 *   `.rules` file loads: neither the user's `~/.codex/rules/*.rules` (where an interactive
 *   "always allow" lands) nor one a role planted in `<worktree>/.codex/rules/`. An `allow`
 *   decision there may run the matched command outside the sandbox, with the network and full
 *   writes; whether it does is for the §7 spike row on Codex host config to confirm, and the flag
 *   makes the answer moot for role runs.
 *   MCP servers from a project `.codex/config.toml` (a linked worktree inside a trusted repo
 *   loads its own, so a role could plant one) are turned off like the user's: `codex exec`
 *   0.162.1 has no flag that drops them, and a `-c` table value merges into the configured
 *   servers rather than replacing them, so the adapter lists what the run would load and turns
 *   each one off by name (`mcp-servers.ts`, `mcp-isolation.json`). The engine's restore of
 *   `.codex/**` before every dispatch and resume stays the barrier for the rest of a planted
 *   project config. Project hooks need persisted trust, and no run ever passes the hook-trust
 *   bypass.
 * - Engine tools through the bridge (D-an, spine §5 reading 71): every role run, fresh or resumed,
 *   pins the engine bridge `[mcp_servers.vtc]` (`engineMcpServer("codex")`, the entry `vtc install`
 *   writes) and limits it: `enabled_tools` is the role's `engine_tools` and nothing else, and
 *   `disabled_tools` is `HUMAN_ONLY_TOOLS`, so `approve`, `answer` and `change_request` never reach
 *   a role run whatever its tools say. The run has `approval_policy="never"`, so nothing asks
 *   before an MCP call, and the engine cannot tell a role run's bridge from the Lead's by its
 *   hello (a role bridge could claim a run whose Lead has gone); the filter is what keeps those
 *   tools out. Checked on codex-cli 0.162.1 (2026-10-14, temp `CODEX_HOME`, a stub stdio server
 *   listing five tools, read back through app-server `mcpServerStatus/list`): `-c
 *   mcp_servers.vtc.disabled_tools=[...]` hides the listed tools, `enabled_tools` keeps only the
 *   listed ones, and `enabled_tools=[]` leaves none. The command and args are pinned too, because a
 *   filter key alone on a config without `[mcp_servers.vtc]` fails to load ("invalid transport").
 *   The Lead's own session is never started here and keeps its tools.
 * - Web search (H-3, D-cf): `cached` for a `host_web` role, explicitly `disabled` for every other
 *   role, never `live`; see {@link CodexWebSearch}. Every role run also turns off the Codex
 *   features that reach pages by another route ({@link CODEX_ROLE_FEATURES_OFF}: the apps
 *   connectors, browser and computer use, and plugins). MCP servers other than the engine bridge
 *   (the user's own in `config.toml`, a trusted project's, a plugin's) would run outside the role
 *   sandbox with the network, a fetch or browser server among them; Claude runs drop them
 *   (`--strict-mcp-config`). Here the adapter lists the servers a run would load before every
 *   start or resume and the command turns each one off by name ({@link CodexCommandOptions}
 *   `.mcpServersOff`, `mcp-servers.ts`); plugins go off with the features above, since a
 *   plugin's servers have no name to turn off (the registered vtc plugin's hooks and server
 *   included). Codex reports `safeHostWeb` false (see `index.ts`; D-cp, spine §5 reading 222).
 * - `codex exec` has no agent flag: a headless run gets no compiled role instructions
 *   (`developer_instructions` of `.codex/agents/vtc-*.toml`), so the role rests on the prompt
 *   (the task pack). Engine core carries the role itself (spine §5 reading 145): the compiled
 *   agent's locked core before the prompt and its editable section in the pack, until the spike
 *   settles how to load the agent.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CODEX_HOST_WEB_SEARCH,
  CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS,
  engineMcpServer,
  HUMAN_ONLY_TOOLS,
  isHumanOnlyTool,
  type HostCommand,
  type RoleTools,
  type SandboxProfile,
  type SandboxProfileRequest,
  type SessionRef,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { checkProfileArgs } from "../common/argv.js";
import { codexMcpServersOffOverride } from "./mcp-servers.js";
import { canonicalPath, vtcHomeWriteDeniedPaths, within } from "../common/homes.js";

export const CODEX_BINARY = "codex";
export const HOST = "codex";

type CodexSandboxMode = "read-only" | "workspace-write";

/**
 * Codex's own web search (H-3 and D-cf, spine §5 readings 156 and 200). `codex exec` has no
 * `--search` flag (only the interactive CLI does, 0.162.1); the top-level `web_search` config key
 * takes `"live"`, `"indexed"`, `"cached"` or `"disabled"` (codex-cli 0.162.1). It is a tool the host
 * provider runs, so the role's sandbox and its network-off setting stay as they are.
 *
 * Codex has no per-path read deny, so a Codex role reads everything the user can (D-ad): a role
 * that could open a page the model picks could carry a credential out in its URL. So the adapter
 * never emits `"live"` (the type has no such value), and a `host_web` role gets
 * `CODEX_HOST_WEB_SEARCH` (`"cached"`: an OpenAI-maintained index, no live page fetch); every other
 * role gets `"disabled"`. Both are set explicitly as a top-level `--config` (`-c`) override,
 * never left to a default (a full-access sandbox defaults to `"live"`). A `code_sandboxed` role
 * with `host_web` is refused, and so is any other override that names web search or a profile
 * (see `checkWebSearchArgs`).
 *
 * The D-cl precedence check (codex-cli 0.162.1, a temporary `CODEX_HOME`, `scripts/dcl-check.ts
 * codex-precedence`, recorded as `test/fixtures/codex/precedence.json`): through `config/read`, a
 * top-level `--config web_search=...` wins over `web_search = "live"` in the user's `config.toml`
 * and in an untrusted project `.codex/config.toml`. A `--profile <name>` layer
 * (`<name>.config.toml`) was compared only through `developer_instructions` markers, where the
 * override won; `codex app-server` refuses `--profile`, so its effective `web_search` is unmeasured.
 * VTC never passes `--profile`, and 0.162.1 refuses the legacy `profile = "<name>"` key ("no longer
 * supported"). With the legacy `[features] web_search_request = true` in the user's config, the
 * override still sets `web_search` and the legacy key stays as it is.
 *
 * The D-cl run check (`codex-web`, 2026-10-15): `cached` searched the index under both role
 * sandboxes, and under `read-only` also opened a page its own results named (`open_page`). Handed a
 * fresh `https://example.com/<random>` URL, its `open_page` returned one result titled "Internal
 * Error" with no page text (the "not accessible" wording is the role's own summary, not the
 * tool's), which does not show that no live fetch happened. `indexed` opened a result page;
 * `disabled` had no search tool, but the apps connectors still offered one, hence
 * {@link CODEX_ROLE_FEATURES_OFF}.
 */
export type CodexWebSearch = typeof CODEX_HOST_WEB_SEARCH | "disabled";

const codexWebSearch = (tools: RoleTools): CodexWebSearch => {
  if (tools.host_web !== true) return "disabled";
  if (tools.profile === "code_sandboxed") {
    throw new Error(
      "refusing host web search for a code_sandboxed Codex role: a role that runs code gets no direct web (H-3, spine §5 reading 156)",
    );
  }
  return CODEX_HOST_WEB_SEARCH;
};

/**
 * Codex features that give a run other routes to pages the model picks, turned off for every
 * role run, whatever its tools (D-cf, D-cl): `apps`, the ChatGPT apps connectors (the
 * `codex_apps` MCP server, whose `search_service.web_run` a role with `web_search="disabled"`
 * still called in the 2026-10-15 live check, codex-cli 0.162.1), and browser and computer use.
 * Also `plugins`: an installed plugin's own MCP servers (its `.mcp.json`) have no config entry a
 * role run could turn off by name, and only turning plugins off drops them (the D-cl offline check,
 * `mcp-isolation.json`; see `mcp-servers.ts`). No role needs any of them: a role run loads no
 * compiled agent or plugin (the engine carries the role in the prompt), and the engine bridge is a
 * separate MCP server and stays.
 */
export const CODEX_ROLE_FEATURES_OFF = [
  "apps",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
  "plugins",
] as const;

const featureOffOverride = (feature: string): string => `features.${feature}=false`;

/** Throws unless the profile turns every {@link CODEX_ROLE_FEATURES_OFF} feature off. */
const checkFeaturesOff = (cliArgs: readonly string[]): void => {
  const values = cliArgs.filter((_, i) => i % 2 === 1);
  const left = CODEX_ROLE_FEATURES_OFF.filter(
    (feature) =>
      !values.includes(featureOffOverride(feature)) ||
      values.some(
        (arg) => arg.startsWith(`features.${feature}=`) && arg !== featureOffOverride(feature),
      ),
  );
  if (left.length > 0) {
    throw new Error(
      `refusing a headless Codex run: its profile leaves on ${left.join(", ")}, other routes to web pages the model picks (D-cf)`,
    );
  }
};

/** The `--config` value that sets web search to `mode`. */
const webSearchOverride = (mode: CodexWebSearch): string => `web_search="${mode}"`;

/** The dotted key a `--config` value sets, without quotes or spaces (`a."b".c=1` → `a.b.c`). */
const configKey = (value: string): string => {
  const at = value.indexOf("=");
  return (at < 0 ? value : value.slice(0, at)).replace(/["'\s]/gu, "").toLowerCase();
};

/**
 * Whether a `--config` value could touch web search: any key that names it on any path (the
 * top-level `web_search`, the legacy `tools.web_search` and `features.web_search_request`,
 * `features.web_search_cached`, `profiles.<x>.web_search`), or that picks or defines a profile
 * (`profile`, `profiles.*`), whose layer could carry its own.
 */
const touchesWebSearch = (value: string): boolean => {
  const key = configKey(value);
  return (
    key.includes("web_search") ||
    key === "profile" ||
    key === "profiles" ||
    key.startsWith("profiles.")
  );
};

/**
 * Throws unless the profile's overrides set web search exactly once, to `cached` or `disabled`,
 * as the top-level key, and nothing else names web search or a profile (D-cf): a profile built
 * anywhere else can never bring live search (or any other mode) in.
 */
const checkWebSearchArgs = (cliArgs: readonly string[]): void => {
  const set = cliArgs.filter((arg, i) => i % 2 === 1 && touchesWebSearch(arg));
  const allowed = [webSearchOverride(CODEX_HOST_WEB_SEARCH), webSearchOverride("disabled")];
  const [only] = set;
  if (set.length !== 1 || only === undefined || !allowed.includes(only)) {
    throw new Error(
      `refusing a headless Codex run: its profile must set web search exactly once, to ${allowed.join(" or ")}, and name no other web search key or profile (never live; D-cf, spine §5 reading 200), got ${set.length === 0 ? "none" : set.map((arg) => JSON.stringify(arg)).join(", ")}`,
    );
  }
};

export interface CodexProfileOptions {
  /** The absolute VTC home (`~/.vtc`, or `$VTC_HOME`), which no role may write (D-w). */
  readonly vtcHome: string;
  /**
   * The OS temp roots a `workspace-write` sandbox can write besides the worktree. Default:
   * `$TMPDIR`, `os.tmpdir()` and `/tmp`; tests pass their own.
   */
  readonly tempRoots?: readonly string[];
  /** The platform the role runs on. Default: `process.platform`; tests pass their own. */
  readonly platform?: NodeJS.Platform;
}

/**
 * Platforms where Codex's network-off sandbox is shown to block a Unix-socket connect into
 * `<vtcHome>/run/` as well as TCP (see the header). Only there does a profile claim
 * `enforced.network`, the engine's condition for running a role that can read the token. The
 * list lives in `@vtc/shared`, where the in-session rule reads it too (spine §5 reading 79).
 */
export { CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS };

const tomlStrings = (values: readonly string[]): string =>
  `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;

/**
 * The engine bridge a role run gets (see the header): the `vtc install` entry, with only the
 * role's `engine_tools` enabled and the human-only tools disabled. Keyed as Codex config.
 */
export const codexRoleBridge = (tools: RoleTools) => {
  const bridge = engineMcpServer(HOST);
  return {
    name: bridge.name,
    command: bridge.command,
    args: [...bridge.args],
    enabled_tools: tools.engine_tools.filter((tool) => !isHumanOnlyTool(tool)),
    disabled_tools: [...HUMAN_ONLY_TOOLS],
  };
};

/** The `--config` override that keeps the human-only tools out of a role run. */
export const codexHumanOnlyToolsOverride = (): string =>
  `mcp_servers.${engineMcpServer(HOST).name}.disabled_tools=${tomlStrings(HUMAN_ONLY_TOOLS)}`;

const codexRoleBridgeArgs = (tools: RoleTools): string[] => {
  const bridge = codexRoleBridge(tools);
  const key = `mcp_servers.${bridge.name}`;
  return [
    "--config",
    `${key}.command=${JSON.stringify(bridge.command)}`,
    "--config",
    `${key}.args=${tomlStrings(bridge.args)}`,
    "--config",
    `${key}.enabled_tools=${tomlStrings(bridge.enabled_tools)}`,
    "--config",
    codexHumanOnlyToolsOverride(),
  ];
};

const defaultTempRoots = (): string[] =>
  [process.env.TMPDIR, tmpdir(), "/tmp"].filter(
    (root): root is string => root !== undefined && root !== "",
  );

export const codexSandboxProfile = (
  request: SandboxProfileRequest,
  options: CodexProfileOptions,
): SandboxProfile => {
  const mode: CodexSandboxMode =
    request.tools.profile === "read_only" ? "read-only" : "workspace-write";
  const webSearch = codexWebSearch(request.tools);
  if (request.network === "registries") {
    throw new Error(
      "refusing the registries network on Codex: it cannot limit the network to package registries (§7.2), and an open network lets a role use the readable VTC install token against the engine; dependency installs are an engine-run step (D-ac)",
    );
  }
  // compared by real location, each path resolved once
  const denied =
    mode === "workspace-write" ? vtcHomeWriteDeniedPaths(options.vtcHome).map(canonicalPath) : [];
  const cwd = denied.length === 0 ? request.cwd : canonicalPath(request.cwd);
  const exposed = denied.find((dir) => within(cwd, dir) || within(dir, cwd));
  if (exposed !== undefined) {
    throw new Error(
      `refusing a workspace-write Codex role in ${request.cwd}: ${exposed} in the VTC home would be writable, and Codex cannot deny writes there (D-w)`,
    );
  }
  // the temp roots are writable too (D-ag); a denied directory under one takes them out
  const tempRoots =
    denied.length === 0 ? [] : (options.tempRoots ?? defaultTempRoots()).map(canonicalPath);
  const noTemp = denied.some((dir) => tempRoots.some((root) => within(root, dir)));
  const { name: bridgeName, ...bridge } = codexRoleBridge(request.tools);
  return {
    host: HOST,
    enforced: {
      readOnly: mode === "read-only",
      perPathWriteDeny: false,
      // fail closed where a Unix-socket connect into `<vtcHome>/run/` is not shown blocked (D-an)
      network: CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS.includes(options.platform ?? process.platform),
      // no per-path read deny on Codex: the token and host credentials stay readable (D-ad)
      secretsUnreadable: false,
      // nor a replay trial's `readDeny` paths: the trial records `paths_only` (readings 178, 204)
      readDeny: false,
    },
    settings: {
      sandbox_mode: mode,
      web_search: webSearch,
      features: Object.fromEntries(CODEX_ROLE_FEATURES_OFF.map((feature) => [feature, false])),
      ...(mode === "workspace-write"
        ? {
            sandbox_workspace_write: {
              network_access: false,
              writable_roots: [],
              ...(noTemp ? { exclude_tmpdir_env_var: true, exclude_slash_tmp: true } : {}),
            },
          }
        : {}),
      mcp_servers: { [bridgeName]: bridge },
    },
    // config overrides, which `codex exec resume` takes too; the command adds `--sandbox` as an
    // option of `exec` (resume itself has no such flag in 0.162.1)
    cliArgs: [
      "--config",
      `sandbox_mode="${mode}"`,
      "--config",
      webSearchOverride(webSearch),
      ...CODEX_ROLE_FEATURES_OFF.flatMap((feature) => ["--config", featureOffOverride(feature)]),
      ...(mode === "workspace-write"
        ? [
            "--config",
            "sandbox_workspace_write.network_access=false",
            "--config",
            "sandbox_workspace_write.writable_roots=[]",
          ]
        : []),
      ...(noTemp
        ? [
            "--config",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "--config",
            "sandbox_workspace_write.exclude_slash_tmp=true",
          ]
        : []),
      // the engine bridge with the role's engine tools only, never a human-only one (D-an)
      ...codexRoleBridgeArgs(request.tools),
    ],
  };
};

/**
 * Where `--output-schema` reads the schema from: a file named by the schema's hash under the
 * adapter's private scratch directory (`spawnRole` writes it before the run starts).
 */
export const codexSchemaFile = (scratchDir: string, schema: Readonly<Record<string, unknown>>) =>
  join(
    scratchDir,
    `role-result-${createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16)}.json`,
  );

export interface CodexCommandOptions {
  readonly scratchDir: string;
  /**
   * The MCP servers besides the engine bridge that the run would load (the user's, a trusted
   * project's), which the command turns off (see `mcp-servers.ts`). The adapter lists them with
   * `codex mcp list` before every start or resume; a bridge name here is ignored. Default: none.
   */
  readonly mcpServersOff?: readonly string[];
}

/**
 * Throws if the profile sets the whole `mcp_servers` table: overrides apply in order, so it would
 * replace the table that turns the user's servers off (codex-cli 0.162.1, `mcp-servers.ts`).
 */
const checkNoMcpTable = (cliArgs: readonly string[]): void => {
  if (cliArgs.some((arg, i) => i % 2 === 1 && configKey(arg) === "mcp_servers")) {
    throw new Error(
      "refusing a headless Codex run: its profile sets the whole mcp_servers table, which would undo the override that keeps the user's MCP servers out of the role run (D-cf)",
    );
  }
};

/** The profile's sandbox mode, read back from its settings; anything else is refused. */
const sandboxModeOf = (sandbox: SandboxProfile): CodexSandboxMode => {
  const mode = sandbox.settings.sandbox_mode;
  if (mode !== "read-only" && mode !== "workspace-write") {
    throw new Error(
      `refusing a headless Codex run: the profile's sandbox mode must be read-only or workspace-write, got ${JSON.stringify(mode)}`,
    );
  }
  return mode;
};

/**
 * `codex exec --json` for a role, or `codex exec … resume --json … <thread_id>` (spike 1 and the
 * 4h resume check). The model is the engine's (`request.model.model`, AD-6 rule 2). The prompt
 * is read from stdin (`-`): the launcher writes it and closes stdin, so it never sits in argv.
 * The thread id follows `--`, so it is never read as an option.
 *
 * Unattended (AD-25 rule 1): an explicit `--sandbox` (an option of `exec`, so it stands before
 * `resume`, which rejects it after itself in 0.162.1; the profile's `sandbox_mode` override says
 * the same) and `-c approval_policy="never"`, so no approval request ever waits for a person.
 * Never an automatic approver or the hook-trust bypass (AD-25 rule 2, AD-9). The profile's
 * overrides carry the engine bridge filter (see the header); a profile without the human-only
 * `disabled_tools` override is refused.
 */
export const codexHeadlessCommand = (
  request: SpawnRoleRequest,
  options: CodexCommandOptions,
  session?: SessionRef,
): HostCommand => {
  if (request.sandbox.host !== HOST) {
    throw new Error(`a ${request.sandbox.host} sandbox profile cannot run on ${HOST}`);
  }
  if (session !== undefined && session.host !== HOST) {
    throw new Error(`cannot resume a ${session.host} session on ${HOST}`);
  }
  if (request.pluginDir !== undefined) {
    throw new Error(
      "refusing a headless Codex run with a replay arm's plugin directory: `codex exec` loads no compiled agent (the engine carries the role in the prompt), so no plugin copy could load or be proven (D-cg)",
    );
  }
  const mode = sandboxModeOf(request.sandbox);
  // only what `codexSandboxProfile` emits: `--config` overrides, never another sandbox flag
  checkProfileArgs(HOST, request.sandbox.cliArgs, ["--config"]);
  checkWebSearchArgs(request.sandbox.cliArgs);
  checkFeaturesOff(request.sandbox.cliArgs);
  checkNoMcpTable(request.sandbox.cliArgs);
  // fail closed: without the filter every engine tool, the human-only ones too, reaches the role
  if (!request.sandbox.cliArgs.includes(codexHumanOnlyToolsOverride())) {
    throw new Error(
      "refusing a headless Codex run: the profile does not disable the human-only engine tools (approve, answer, change_request) on the engine bridge (D-an)",
    );
  }
  const bridge = engineMcpServer(HOST).name;
  const serversOff = (options.mcpServersOff ?? []).filter((name) => name !== bridge);
  return {
    command: CODEX_BINARY,
    args: [
      "exec",
      "--sandbox",
      mode,
      ...(session === undefined ? [] : ["resume"]),
      "--json",
      // every MCP server but the bridge off, before the profile's bridge keys: a later
      // whole-table override would replace them (see `mcp-servers.ts`)
      ...(serversOff.length === 0 ? [] : ["--config", codexMcpServersOffOverride(serversOff)]),
      ...request.sandbox.cliArgs,
      // nobody answers an approval request in an unattended run: none is ever asked
      "-c",
      'approval_policy="never"',
      "--output-schema",
      codexSchemaFile(options.scratchDir, request.outputSchema),
      // no resolved id (D-ae): the session's default model runs, only the effort is set
      ...(request.model.model === undefined ? [] : ["--model", request.model.model]),
      "--config",
      `model_reasoning_effort="${request.model.effort}"`,
      // no notify command, from the user's config or one a role planted in the worktree (D-ao)
      "--config",
      "notify=[]",
      // no execpolicy `.rules` (the user's `~/.codex/rules`, or one planted in the worktree): an
      // `allow` decision there would run a matching command outside the role sandbox (D-ao)
      "--ignore-rules",
      "--",
      ...(session === undefined ? [] : [session.id]),
      "-",
    ],
    env: {},
  };
};
