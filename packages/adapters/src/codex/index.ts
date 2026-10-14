/**
 * Codex host adapter (§4.1, §12.1, AD-6). Usage comes from the adapter's own managed
 * `codex app-server` child (`readUsage` / `watchUsage`, stopped by `dispose`, AD-6 rule 4).
 * Engine-launched runs are unattended (AD-25; a Codex Lead's roles run this way, H-1): an
 * explicit sandbox and no approval prompts, process-group supervision, and `authStatus()` through
 * `codex login status` before every start or resume.
 */
import { join } from "node:path";
import type { HostAdapter, HostCapabilities, SessionRef, SpawnRoleRequest } from "@vtc/shared";
import { createAuthStatusRunner } from "../common/auth-status.js";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { envHome } from "../common/homes.js";
import { ensurePrivateDir, writeOwnFileAtomic } from "../common/files.js";
import { createNodeSpawner, type Spawner } from "../common/process.js";
import { createCodexUsageSource } from "./app-server.js";
import { CODEX_AUTH_STATUS } from "./auth.js";
import { codexHeadlessCommand, codexSandboxProfile, codexSchemaFile, HOST } from "./command.js";
import { codexOutcomeAfterExit, parseCodexEvents } from "./events.js";
import { installCodex } from "./install.js";

/**
 * §12.1 / §20.4: subagents are spawned explicitly (foreground), no background agents in the CLI,
 * no per-path write-deny, caps enforced by the engine only.
 */
export const codexCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: false,
  perPathWriteDeny: false,
  headless: true,
  turnCap: false,
  budgetCap: false,
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
}

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

  const headlessCommand = (request: SpawnRoleRequest, session?: SessionRef) =>
    codexHeadlessCommand(request, commandOptions, session);

  const spawn = (request: SpawnRoleRequest, session?: SessionRef) =>
    Promise.resolve().then(() => {
      if (request.dispatch === "subagent") {
        return subagentSpawn(request, { background: codexCapabilities.backgroundSubagents });
      }
      const command = headlessCommand(request, session);
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
    install: (request) => Promise.resolve().then(() => installCodex(request)),
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
      await Promise.all([runs.dispose(), usage?.dispose()]);
    },
  };
};

export { codexUsageFromRateLimits } from "./rate-limits.js";
