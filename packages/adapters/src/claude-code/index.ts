/**
 * Claude Code host adapter (§4.1, §12.1, AD-6). Usage is pushed, not pulled (AD-6 rule 4): the
 * statusline shim posts `statuslineIngestFromClaude(...)` to the engine, and `parseEvents`
 * returns the SDK rate-limit readings of runs the engine launched. So there is no `readUsage`.
 * Engine-launched runs are unattended (AD-25): an isolated argv, process-group supervision, and
 * `authStatus()` through `claude auth status --json` before every start or resume.
 */
import { readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import {
  agentNameFor,
  HOST_CREDENTIAL_DENY_READ,
  type HeadlessRun,
  type HostAdapter,
  type HostCapabilities,
  type SessionRef,
  type SpawnResult,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createAuthStatusRunner } from "../common/auth-status.js";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { envHome } from "../common/homes.js";
import { createNodeSpawner, type Spawner } from "../common/process.js";
import {
  claudeArmDebugFile,
  claudeHeadlessCommand,
  claudeSandboxProfile,
  claudeSubagentName,
  HOST,
} from "./command.js";
import { CLAUDE_AUTH_STATUS } from "./auth.js";
import { claudeOutcomeAfterExit, parseClaudeEvents } from "./events.js";
import { installClaudeCode } from "./install.js";
import { claudePluginLoadProof, DEBUG_LOG_MAX_BYTES } from "./plugin-load.js";

/**
 * §12.1: plugin agents run in the background; `sandbox.filesystem.denyWrite`; `--max-turns`,
 * `--max-budget-usd`. Host web is safe (D-cf, spine §5 reading 200): a `host_web` role's profile
 * denies reading the VTC token, the host credentials and the user's credential stores, from the
 * tools and from the shell, so a page its `WebFetch` opens cannot be handed one of them.
 */
export const claudeCodeCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: true,
  perPathWriteDeny: true,
  headless: true,
  turnCap: true,
  budgetCap: true,
  safeHostWeb: true,
};

export interface ClaudeCodeAdapterOptions {
  /** Starts host processes; tests inject a fake (never the real `claude`). */
  readonly spawner?: Spawner;
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
  /**
   * The absolute VTC home, whose `ROLE_DENIED_VTC` paths the profiles and the session sandbox
   * written by `install` deny. Default: `$VTC_HOME`, else `~/.vtc` (the cli's own rule); the cli
   * passes the one it resolved.
   */
  readonly vtcHome?: string;
  /** The absolute Codex home, which no role may read. Default: `$CODEX_HOME`, else `~/.codex`. */
  readonly codexHome?: string;
  /**
   * Claude's config directory, whose credential file no role may read (D-ad). Default:
   * `$CLAUDE_CONFIG_DIR`, else `~/.claude`. Only a path for the deny rules: never read.
   */
  readonly claudeConfigDir?: string;
  /**
   * The user's home, whose credential stores (`HOME_CREDENTIAL_LOCATIONS`) no role may read.
   * Default: `os.homedir()`. Only a path for the deny rules: never read.
   */
  readonly homeDir?: string;
  /**
   * The compiled Claude plugin on disk; see `ClaudeCommandOptions.pluginDir`. Required for
   * headless runs: without it `headlessCommand`, `spawnRole` (headless) and `resume` refuse.
   */
  readonly pluginDir?: string;
  /**
   * Variable names from the user's `~/.vtc/config.yaml` `env_passthrough` (D-ak, spine §5 reading
   * 57) that pass to host children besides the fixed allowlist; host credential variables never
   * do. Used by the default spawner only. Default: none.
   */
  readonly envPassthrough?: readonly string[];
  /** Clock for `authStatus().checked_at`. */
  readonly now?: () => Date;
  /** How long `claude auth status` may run before it is killed. Default 20 s. */
  readonly authTimeoutMs?: number;
}

/** Reads a debug log for the load proof: null when it is missing, unreadable or too large. */
const readDebugLog = (path: string): string | null => {
  try {
    if (statSync(path).size > DEBUG_LOG_MAX_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const realPath = (path: string): string => {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
};

/**
 * `run` with `pluginLoad()` (D-cg): after the run has ended, which plugin copy it loaded, from its
 * stream's `init` record and its debug log ({@link claudePluginLoadProof}).
 */
const withPluginLoad = (
  run: HeadlessRun,
  arm: { readonly armDir: string; readonly agent: string; readonly debugFile: string },
): HeadlessRun => ({
  command: run.command,
  pid: run.pid,
  lines: () => run.lines(),
  wait: () => run.wait(),
  kill: () => run.kill(),
  async pluginLoad() {
    await run.wait();
    const lines: string[] = [];
    for await (const line of run.lines()) lines.push(line);
    return claudePluginLoadProof({
      armDir: arm.armDir,
      agent: arm.agent,
      lines,
      debugLog: readDebugLog(arm.debugFile),
      realPath,
    });
  },
});

export const createClaudeCodeAdapter = (options: ClaudeCodeAdapterOptions = {}): HostAdapter => {
  const spawner =
    options.spawner ?? createNodeSpawner({ envPassthrough: options.envPassthrough ?? [] });
  const runs = createRunLauncher({
    host: HOST,
    spawner,
    outcome: claudeOutcomeAfterExit,
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
  const codex = HOST_CREDENTIAL_DENY_READ.codex;
  const claude = HOST_CREDENTIAL_DENY_READ["claude-code"];
  const profileOptions = {
    vtcHome: options.vtcHome ?? envHome("VTC_HOME", ".vtc"),
    codexHome: options.codexHome ?? envHome(codex.configDirEnv, codex.defaultConfigDir),
    claudeConfigDir:
      options.claudeConfigDir ?? envHome(claude.configDirEnv, claude.defaultConfigDir),
    homeDir: options.homeDir ?? homedir(),
  };
  const commandOptions = options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir };
  const headlessCommand = (request: SpawnRoleRequest, session?: SessionRef) =>
    claudeHeadlessCommand(request, session, commandOptions);
  const spawn = (request: SpawnRoleRequest, session?: SessionRef) =>
    Promise.resolve().then((): SpawnResult => {
      if (request.dispatch === "subagent") {
        return subagentSpawn(request, {
          background: claudeCodeCapabilities.backgroundSubagents,
          name: claudeSubagentName,
        });
      }
      const command = headlessCommand(request, session);
      if (request.pluginDir === undefined) return runs.start(command, request);
      // a replay arm (D-cg): a log left by an earlier run must never stand in for this one's
      const debugFile = claudeArmDebugFile(request.pluginDir);
      rmSync(debugFile, { force: true });
      const started = runs.start(command, request);
      if (started.dispatch !== "headless") return started;
      const agent = claudeSubagentName(agentNameFor(request.role, request.mode));
      return {
        dispatch: "headless",
        run: withPluginLoad(started.run, { armDir: request.pluginDir, agent, debugFile }),
      };
    });
  return {
    host: HOST,
    capabilities: claudeCodeCapabilities,
    install: (request) => Promise.resolve().then(() => installClaudeCode(request)),
    spawnRole: (request) => spawn(request),
    subagentName: claudeSubagentName,
    parseEvents: parseClaudeEvents,
    headlessCommand,
    resume: (session, request) => {
      if (session.host !== HOST) {
        return Promise.reject(new Error(`cannot resume a ${session.host} session on ${HOST}`));
      }
      return spawn(request, session);
    },
    sandboxProfile: (request) => claudeSandboxProfile(request, profileOptions),
    authStatus: () => auth.check(CLAUDE_AUTH_STATUS),
    async dispose() {
      auth.dispose();
      await runs.dispose();
    },
  };
};

export { statuslineIngestFromClaude } from "./statusline.js";
export { claudeSubagentName } from "./command.js";
