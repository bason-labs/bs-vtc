/**
 * Claude Code host adapter (§4.1, §12.1, AD-6). Usage is pushed, not pulled (AD-6 rule 4): the
 * statusline shim posts `statuslineIngestFromClaude(...)` to the engine, and `parseEvents`
 * returns the SDK rate-limit readings of runs the engine launched. So there is no `readUsage`.
 * Engine-launched runs are unattended (AD-25): an isolated argv, process-group supervision, and
 * `authStatus()` through `claude auth status --json` before every start or resume.
 */
import {
  HOST_CREDENTIAL_DENY_READ,
  type HostAdapter,
  type HostCapabilities,
  type SessionRef,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createAuthStatusRunner } from "../common/auth-status.js";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { envHome } from "../common/homes.js";
import { createNodeSpawner, type Spawner } from "../common/process.js";
import {
  claudeHeadlessCommand,
  claudeSandboxProfile,
  claudeSubagentName,
  HOST,
} from "./command.js";
import { CLAUDE_AUTH_STATUS } from "./auth.js";
import { claudeOutcomeAfterExit, parseClaudeEvents } from "./events.js";
import { installClaudeCode } from "./install.js";

/** §12.1: plugin agents run in the background; `sandbox.filesystem.denyWrite`; `--max-turns`, `--max-budget-usd`. */
export const claudeCodeCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: true,
  perPathWriteDeny: true,
  headless: true,
  turnCap: true,
  budgetCap: true,
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

export const createClaudeCodeAdapter = (options: ClaudeCodeAdapterOptions = {}): HostAdapter => {
  const spawner =
    options.spawner ?? createNodeSpawner({ envPassthrough: options.envPassthrough ?? [] });
  const runs = createRunLauncher({
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
  };
  const commandOptions = options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir };
  const headlessCommand = (request: SpawnRoleRequest, session?: SessionRef) =>
    claudeHeadlessCommand(request, session, commandOptions);
  const spawn = (request: SpawnRoleRequest, session?: SessionRef) =>
    Promise.resolve().then(() =>
      request.dispatch === "subagent"
        ? subagentSpawn(request, {
            background: claudeCodeCapabilities.backgroundSubagents,
            name: claudeSubagentName,
          })
        : runs.start(headlessCommand(request, session), request),
    );
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
