/**
 * Codex host adapter (§4.1, §12.1, AD-6). Usage comes from the adapter's own managed
 * `codex app-server` child (`readUsage` / `watchUsage`, stopped by `dispose`, AD-6 rule 4).
 */
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { HostAdapter, HostCapabilities, SessionRef, SpawnRoleRequest } from "@vtc/shared";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { envHome } from "../common/homes.js";
import { ensurePrivateDir, writeFileAtomic } from "../common/files.js";
import { nodeSpawner, type Spawner } from "../common/process.js";
import { createCodexUsageSource } from "./app-server.js";
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
   * `--output-schema` files. Default: `<os tmp>/vtc-codex-<user id>`.
   */
  readonly scratchDir?: string;
  /** Working directory of the `codex app-server` child. Default: the scratch directory. */
  readonly appServerCwd?: string;
  readonly now?: () => Date;
  readonly usagePollMs?: number;
  readonly killGraceMs?: number;
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
}

/** Per user, so two users of one machine never share it (and a planted one is refused). */
const defaultScratchDir = (): string =>
  join(tmpdir(), `vtc-codex-${String(process.getuid?.() ?? userInfo().username)}`);

export const createCodexAdapter = (options: CodexAdapterOptions = {}): HostAdapter => {
  const spawner = options.spawner ?? nodeSpawner;
  const scratchDir = options.scratchDir ?? defaultScratchDir();
  const commandOptions = { scratchDir };
  const profileOptions = {
    vtcHome: options.vtcHome ?? envHome("VTC_HOME", ".vtc"),
    ...(options.platform === undefined ? {} : { platform: options.platform }),
  };
  const runs = createRunLauncher({
    spawner,
    outcome: codexOutcomeAfterExit,
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
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
      // atomic: another run with the same schema may be reading the file right now
      writeFileAtomic(
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
    async dispose() {
      await Promise.all([runs.dispose(), usage?.dispose()]);
    },
  };
};

export { codexUsageFromRateLimits } from "./rate-limits.js";
