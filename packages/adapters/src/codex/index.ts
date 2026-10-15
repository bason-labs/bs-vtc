/**
 * Codex host adapter (§4.1, §12.1, AD-6). Usage comes from the adapter's own managed
 * `codex app-server` child (`readUsage` / `watchUsage`, stopped by `dispose`, AD-6 rule 4).
 * Engine-launched runs are unattended (AD-25; a Codex Lead's roles run this way, H-1): an
 * explicit sandbox and no approval prompts, process-group supervision, and `authStatus()` through
 * `codex login status` before every start or resume. Before every headless start or resume the
 * adapter also lists the MCP servers the run would load (`codex mcp list --json`) and starts it
 * only with every one but the engine bridge turned off (`mcp-servers.ts`).
 */
import { join } from "node:path";
import {
  engineMcpServer,
  type HostAdapter,
  type HostCapabilities,
  type SessionRef,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createAuthStatusRunner } from "../common/auth-status.js";
import { createCommandOutputRunner } from "../common/command-output.js";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { envHome } from "../common/homes.js";
import { ensurePrivateDir, writeOwnFileAtomic } from "../common/files.js";
import { createNodeSpawner, type Spawner } from "../common/process.js";
import { createCodexUsageSource } from "./app-server.js";
import { CODEX_AUTH_STATUS } from "./auth.js";
import { codexHeadlessCommand, codexSandboxProfile, codexSchemaFile, HOST } from "./command.js";
import { codexOutcomeAfterExit, parseCodexEvents } from "./events.js";
import { codexConfigArgs, createCodexMcpGuard } from "./mcp-servers.js";
import { installCodex } from "./install.js";

/**
 * §12.1 / §20.4: subagents are spawned explicitly (foreground), no background agents in the CLI,
 * no per-path write-deny, caps enforced by the engine only. Host web is not yet safe (D-cf, spine
 * §5 reading 200, §7 H-3 row: "until both pass, Codex reports `safeHostWeb` false"), so the engine
 * routes `host_web` roles to Claude Code or runs them without host web. What the D-cl checks
 * showed (codex-cli 0.162.1, 2026-10-15, `scripts/dcl-check.ts`, `test/fixtures/codex/`):
 * - `cached` searched the index under both role sandboxes; under `read-only` it also opened a
 *   page its own results named (`open_page`, `exec-web-search-cached-read-only.jsonl`).
 * - Handed a fresh `https://example.com/<random>` URL, `cached` tried `open_page` and the tool
 *   returned one result titled "Internal Error" with no page text; the role then reported it could
 *   not open the page. That cannot tell "no live fetch" from "fetched and failed", so it does not
 *   show the property reading 200 needs: that no page the model picks is fetched. No external
 *   probe server is set up to settle it (D-cp, spine §5 reading 222).
 * - A top-level `-c web_search=...` beat the user's `config.toml` and an untrusted project
 *   `.codex/config.toml` (`config/read`); VTC never passes `--profile`, whose layer was compared
 *   only through `developer_instructions` markers (`precedence.json`).
 * - With the apps connectors off no `codex_apps` web tool was called. MCP servers other than the
 *   engine bridge (the user's, a trusted project's, a plugin's), one of which may fetch pages,
 *   are kept out of every role run: plugins are off, and before every start or resume the adapter
 *   lists the rest with `codex mcp list` and turns each off by name, then checks that none is left
 *   on, or refuses the run (`mcp-servers.ts`; offline check `mcp-isolation.json`). That closes the
 *   second §7 H-3 item.
 * So `safeHostWeb` stays false (D-cp, reading 222): `host_web` roles go to Claude Code, or run
 * without host web plus the `web` fetcher (`hostWebRoute`). It is revisited only if OpenAI
 * documents that `cached` has no fetch path.
 */
export const codexCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: false,
  perPathWriteDeny: false,
  headless: true,
  turnCap: false,
  budgetCap: false,
  safeHostWeb: false,
};

export interface CodexAdapterOptions {
  /** Starts host processes; tests inject a fake (never the real `codex`). */
  readonly spawner?: Spawner;
  /**
   * A private directory (0700, created if missing, refused if anyone else can reach it) for the
   * `--output-schema` files, which no role may write (the engine writes the file outside any
   * sandbox, so a role that could plant a link there could have it overwrite any file of the
   * user's, D-w). Default: `<vtcHome>/run/codex`, under `run/**` of `ROLE_DENIED_VTC
   * .homeWriteDeny`; never the OS temp directory, which roles may write (D-ag).
   */
  readonly scratchDir?: string;
  /**
   * Working directory of the `codex app-server` child, a directory no role may write (a file
   * planted in it must never be what runs, §15). Default: the scratch directory.
   */
  readonly appServerCwd?: string;
  readonly now?: () => Date;
  readonly usagePollMs?: number;
  /**
   * SIGTERM → SIGKILL grace when a headless run is stopped. Default
   * `HEADLESS_DEFAULTS.termGraceMs` (AD-25 rule 4).
   */
  readonly killGraceMs?: number;
  /**
   * SIGINT → SIGTERM grace when a headless run is stopped. Default
   * `HEADLESS_DEFAULTS.interruptGraceMs` (AD-25 rule 4).
   */
  readonly interruptGraceMs?: number;
  /** Reported to the app-server as the client version. */
  readonly clientVersion?: string;
  /**
   * The absolute VTC home no role may write (D-w). Default: `$VTC_HOME`, else `~/.vtc` (the
   * cli's own rule); the cli passes the one it resolved.
   */
  readonly vtcHome?: string;
  /**
   * The platform roles run on, which decides whether the sandbox profile can claim the network
   * is enforced (see `CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS`). Default: `process.platform`.
   */
  readonly platform?: NodeJS.Platform;
  /**
   * Variable names from the user's `~/.vtc/config.yaml` `env_passthrough` (D-ak, spine §5 reading
   * 57) that pass to host children besides the fixed allowlist; host credential variables never
   * do. Used by the default spawner only. Default: none.
   */
  readonly envPassthrough?: readonly string[];
  /** How long `codex login status` may run before it is killed. Default 20 s. */
  readonly authTimeoutMs?: number;
  /**
   * How long one `codex mcp list` (the MCP check before every headless start or resume) may run
   * before it is killed and the run refused. Default 20 s.
   */
  readonly mcpListTimeoutMs?: number;
  /**
   * The Codex home `install` registers the plugin in (`codex plugin …` runs with this
   * `CODEX_HOME`). Default: `$CODEX_HOME`, else `<InstallRequest.home>/.codex`, where Codex
   * itself looks.
   */
  readonly codexHome?: string;
  /** How long one `codex plugin …` command of `install` may run before it is killed. Default 60 s. */
  readonly installCommandTimeoutMs?: number;
}

/** How many role cwds' MCP server names the adapter remembers for `headlessCommand`. */
const MCP_NAMES_KEPT = 256;

export const createCodexAdapter = (options: CodexAdapterOptions = {}): HostAdapter => {
  const spawner =
    options.spawner ?? createNodeSpawner({ envPassthrough: options.envPassthrough ?? [] });
  const vtcHome = options.vtcHome ?? envHome("VTC_HOME", ".vtc");
  // under `run/`, which no role can write (D-w): a role never reaches the schema file
  const scratchDir = options.scratchDir ?? join(vtcHome, "run", "codex");
  const commandOptions = { scratchDir };
  const profileOptions = {
    vtcHome,
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const runs = createRunLauncher({
    host: HOST,
    spawner,
    outcome: codexOutcomeAfterExit,
    ...(options.killGraceMs === undefined ? {} : { termGraceMs: options.killGraceMs }),
    ...(options.interruptGraceMs === undefined
      ? {}
      : { interruptGraceMs: options.interruptGraceMs }),
  });
  const auth = createAuthStatusRunner({
    spawner,
    now: options.now ?? (() => new Date()),
    ...(options.authTimeoutMs === undefined ? {} : { timeoutMs: options.authTimeoutMs }),
  });
  const installCommands = createCommandOutputRunner({
    spawner,
    timeoutMs: options.installCommandTimeoutMs ?? 60_000,
    maxChars: 64 * 1024,
  });
  let usage: ReturnType<typeof createCodexUsageSource> | null = null;
  const usageSource = () => {
    if (usage === null) {
      ensurePrivateDir(scratchDir);
      usage = createCodexUsageSource({
        spawner,
        now: options.now ?? (() => new Date()),
        cwd: options.appServerCwd ?? scratchDir,
        clientVersion: options.clientVersion ?? "0.0.0",
        ...(options.usagePollMs === undefined ? {} : { pollMs: options.usagePollMs }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      });
    }
    return usage;
  };

  const mcp = createCodexMcpGuard({
    spawner,
    bridge: engineMcpServer(HOST).name,
    ...(options.mcpListTimeoutMs === undefined ? {} : { timeoutMs: options.mcpListTimeoutMs }),
  });
  // The servers to turn off per role cwd, as the last listing before a start or resume found
  // them (see `mcp-servers.ts`). `headlessCommand` reads them, so the command a run starts with
  // is exactly `headlessCommand(request, session)` at that moment; for a cwd never listed it turns
  // nothing off (only plugins), and no run starts before its cwd is listed.
  const mcpServersOff = new Map<string, readonly string[]>();
  const rememberMcpServersOff = (cwd: string, names: readonly string[]): void => {
    mcpServersOff.delete(cwd);
    mcpServersOff.set(cwd, names);
    const oldest = mcpServersOff.keys().next();
    if (mcpServersOff.size > MCP_NAMES_KEPT && oldest.done !== true) {
      mcpServersOff.delete(oldest.value);
    }
  };

  const headlessCommand = (request: SpawnRoleRequest, session?: SessionRef) =>
    codexHeadlessCommand(
      request,
      { ...commandOptions, mcpServersOff: mcpServersOff.get(request.cwd) ?? [] },
      session,
    );

  const spawn = (request: SpawnRoleRequest, session?: SessionRef) =>
    Promise.resolve().then(async () => {
      if (request.dispatch === "subagent") {
        return subagentSpawn(request, { background: codexCapabilities.backgroundSubagents });
      }
      // validates the request (it throws before anything runs), and gives the run's overrides
      const probe = codexHeadlessCommand(request, commandOptions, session);
      rememberMcpServersOff(
        request.cwd,
        await mcp.serversToTurnOff(request.cwd, codexConfigArgs(probe.args)),
      );
      const command = headlessCommand(request, session);
      await mcp.confirmOff(request.cwd, codexConfigArgs(command.args));
      ensurePrivateDir(scratchDir);
      // atomic: another run with the same schema may be reading the file right now; never
      // through a link, whoever put one there
      writeOwnFileAtomic(
        codexSchemaFile(scratchDir, request.outputSchema),
        JSON.stringify(request.outputSchema),
      );
      return runs.start(command, request);
    });

  return {
    host: HOST,
    capabilities: codexCapabilities,
    install: (request) =>
      Promise.resolve().then(() =>
        installCodex(request, {
          run: (command, cwd) => installCommands.run(command, cwd),
          codexHome:
            options.codexHome ??
            (process.env.CODEX_HOME === undefined || process.env.CODEX_HOME === ""
              ? join(request.home, ".codex")
              : process.env.CODEX_HOME),
        }),
      ),
    spawnRole: (request) => spawn(request),
    parseEvents: parseCodexEvents,
    headlessCommand,
    resume: (session, request) => {
      if (session.host !== HOST) {
        return Promise.reject(new Error(`cannot resume a ${session.host} session on ${HOST}`));
      }
      return spawn(request, session);
    },
    sandboxProfile: (request) => codexSandboxProfile(request, profileOptions),
    readUsage: () => usageSource().read(),
    watchUsage: (onUpdate) => usageSource().watch(onUpdate),
    authStatus: () => auth.check(CODEX_AUTH_STATUS),
    async dispose() {
      auth.dispose();
      mcp.dispose();
      installCommands.dispose();
      await Promise.all([runs.dispose(), usage?.dispose()]);
    },
  };
};

export { codexUsageFromRateLimits } from "./rate-limits.js";
