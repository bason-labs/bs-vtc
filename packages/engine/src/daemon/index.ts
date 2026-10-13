/**
 * Daemon composition (AD-19; owner: engine-core team, sub-project 1). Implements the frozen
 * seam from @vtc/shared: `runDaemon` takes the engine lock, wires core to the injected Gate
 * Runner, host adapters, storage, assets and timer, serves MCP on the local socket and HTTP/SSE
 * on 127.0.0.1, and publishes discovery (AD-12); `serveSnapshot` serves the committed `.vtc/`
 * read-only for `vtc dashboard` (AD-5 rule 7). It may import the core, git, http and mcp entries;
 * it never imports gates (the Gate Runner arrives in `EngineDeps`) and never loads a storage
 * driver (the cli injects `openStorage`).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  dotenvValues,
  ENGINE_HTTP,
  ENGINE_INSTANCE,
  engineSocketFile,
  engineWindowsPipe,
  HOST_IDS,
  usageFromStatuslineIngest,
  type AssetBundle,
  type EngineDeps,
  type HostId,
  type RunDaemon,
  type RunningDaemon,
  type RunningSnapshot,
  type ServeSnapshot,
} from "@vtc/shared";
import {
  acquireEngineLock,
  createReadModel,
  createRoleRegistry,
  Engine,
  INDEX_PATH,
  loadRuns,
  openEventIndex,
  removeEngineDiscovery,
  writeEngineDiscovery,
} from "../core/index.js";
import { createGhPullRequests, createGitOps, createWorkspace } from "../git/index.js";
import {
  createHttpApi,
  createPrototypeServer,
  createSessionStore,
  type PrototypeServer,
} from "../http/index.js";
import { serveEngineSocket } from "../mcp/index.js";

/**
 * The repo's `.env` values (AD-18 rule 1), re-read when the file changes: snapshot mode still
 * appends design-review pins to git-tracked `.vtc/design/reviews/`, redacted like the engine's.
 */
export const dotenvSecrets = (repoRoot: string): (() => readonly string[]) => {
  let cached: { stamp: number; values: readonly string[] } | null = null;
  return () => {
    const path = join(repoRoot, ".env");
    const stamp = ((): number => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return -1;
      }
    })();
    if (cached?.stamp !== stamp) {
      const values = ((): readonly string[] => {
        try {
          return stamp < 0 ? [] : dotenvValues(readFileSync(path, "utf8"));
        } catch {
          return [];
        }
      })();
      cached = { stamp, values };
    }
    return cached.values;
  };
};

/** How often the daemon checks whether it is idle (AD-12 rule 4). */
export const IDLE_CHECK_MS = 60_000;

/**
 * The prompt version of a compiled agent (§13): the SHA-256 of its file in the host's plugin
 * namespace, or of the agent name when the bundle carries no such file (development).
 */
export const promptShaFrom =
  (assets: AssetBundle) =>
  (agent: string, host: HostId): string => {
    const namespace = `plugin:${host}` as const;
    const file = assets
      .list(namespace)
      .find((p) => p.split("/").at(-1)?.startsWith(`${agent}.`) === true);
    const bytes = file === undefined ? undefined : assets.read(namespace, file);
    return createHash("sha256")
      .update(bytes ?? Buffer.from(agent))
      .digest("hex");
  };

const socketPath = (vtcHome: string, repoRoot: string): string =>
  process.platform === "win32"
    ? engineWindowsPipe(repoRoot)
    : join(vtcHome, engineSocketFile(repoRoot));

const prototypeIfAny = async (repoRoot: string): Promise<PrototypeServer | null> =>
  existsSync(join(repoRoot, ENGINE_HTTP.prototype.root)) ? createPrototypeServer(repoRoot) : null;

const prototypeUrl = (server: PrototypeServer | null): string | null =>
  server === null ? null : `http://127.0.0.1:${String(server.port)}/`;

export const runDaemon: RunDaemon = async (deps: EngineDeps, options) => {
  const now = deps.now ?? (() => new Date());
  let staleHolder: number | null | undefined;
  const lock = acquireEngineLock(deps.repoRoot, {
    now,
    onStaleLock: (pid) => {
      staleHolder = pid;
    },
  });
  const cleanups: (() => Promise<void> | void)[] = [
    () => {
      lock.release();
    },
  ];
  const cleanup = async (): Promise<void> => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch {
        // keep shutting down
      }
    }
  };
  try {
    const git = createGitOps({ repoRoot: deps.repoRoot });
    const engine = Engine.open({
      repoRoot: deps.repoRoot,
      vtcHome: deps.vtcHome,
      lock,
      gateRunner: deps.gateRunner,
      git,
      workspace: createWorkspace(deps.repoRoot),
      pullRequests: createGhPullRequests(deps.repoRoot),
      adapters: deps.adapters,
      autoResume: deps.scheduler,
      roles: createRoleRegistry(),
      now,
      random: Math.random,
      promptSha: promptShaFrom(deps.assets),
      remote: "origin",
    });
    cleanups.push(() => engine.settle());
    if (staleHolder !== undefined) {
      engine.recordIncident(
        "stale_lock",
        `took over the engine lock left by ${staleHolder === null ? "an unknown process" : `pid ${String(staleHolder)}`}`,
      );
    }
    try {
      mkdirSync(dirname(join(deps.repoRoot, INDEX_PATH)), { recursive: true });
      const index = openEventIndex(
        deps.openStorage({ path: join(deps.repoRoot, INDEX_PATH) }),
        engine.states(),
      );
      const off = engine.onEvent((event) => {
        index.append(event);
      });
      cleanups.push(() => {
        off();
        index.close();
      });
    } catch {
      // the index is a cache (AD-2 rule 4): the engine works from the logs without it
    }
    for (const host of HOST_IDS) {
      const adapter = deps.adapters[host];
      if (adapter?.watchUsage === undefined) continue;
      cleanups.push(
        adapter.watchUsage((snapshot) => {
          engine.ingestUsage(snapshot);
        }),
      );
    }
    const prototype = await prototypeIfAny(deps.repoRoot);
    if (prototype !== null) cleanups.push(() => prototype.close());
    const http = await createHttpApi({
      readModel: createReadModel({
        repoRoot: deps.repoRoot,
        mode: "live",
        versions: deps.versions,
        prototypeUrl: () => prototypeUrl(prototype),
        runs: () => engine.states(),
        usage: () => engine.usage,
        git,
      }),
      installToken: deps.installToken,
      sessions: createSessionStore(now),
      assets: deps.assets,
      repoRoot: deps.repoRoot,
      ingest: (body) => {
        engine.ingestUsage(usageFromStatuslineIngest(body, now().toISOString()));
      },
      subscribe: (listener) => engine.onEvent(listener),
      secrets: () => engine.secrets(),
      now,
    });
    cleanups.push(() => http.close());
    let lastActive = now().getTime();
    const touch = (): void => {
      lastActive = now().getTime();
    };
    const socket = await serveEngineSocket({
      path: socketPath(deps.vtcHome, deps.repoRoot),
      host: engine,
      versions: deps.versions,
      onActivity: touch,
    });
    cleanups.push(() => socket.close());
    const discovery = {
      v: 1 as const,
      pid: process.pid,
      port: http.port,
      prototype_port: prototype?.port ?? null,
      mcp_socket: socket.path,
      repo_root: deps.repoRoot,
      started_at: now().toISOString(),
      engine_version: deps.versions.engine,
      contracts_version: deps.versions.contracts,
    };
    writeEngineDiscovery(deps.vtcHome, discovery);
    cleanups.push(() => {
      removeEngineDiscovery(deps.vtcHome, deps.repoRoot, process.pid);
    });
    if (options.wake) await engine.wake();
    let resolveClosed: () => void = () => undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    let closing: Promise<void> | null = null;
    // Idle exit (AD-12 rule 4): no background work or role run in flight, no bridge, no wake-up.
    const idle = setInterval(() => {
      const busy =
        engine.busy() || socket.connections().bridge > 0 || engine.autoResumeAt() !== null;
      if (busy) touch();
      else if (now().getTime() - lastActive >= ENGINE_INSTANCE.idleExitMs) void close();
    }, IDLE_CHECK_MS);
    idle.unref();
    const close = (): Promise<void> =>
      (closing ??= (async () => {
        clearInterval(idle);
        await cleanup();
        resolveClosed();
      })());
    const running: RunningDaemon = {
      port: http.port,
      prototypePort: prototype?.port ?? null,
      closed,
      close,
      discovery,
    };
    return running;
  } catch (error) {
    await cleanup();
    throw error;
  }
};

/** How long snapshot mode reuses a replay before re-reading the committed logs. */
const SNAPSHOT_TTL_MS = 2_000;

export const serveSnapshot: ServeSnapshot = async (deps) => {
  const now = deps.now ?? (() => new Date());
  let cached: { at: number; runs: ReturnType<typeof loadRuns> } | null = null;
  const runs = () => {
    const t = now().getTime();
    if (cached === null || t - cached.at > SNAPSHOT_TTL_MS) {
      cached = { at: t, runs: loadRuns(deps.repoRoot) };
    }
    return cached.runs.map((r) => r.state);
  };
  const sessions = createSessionStore(now);
  const prototype = await prototypeIfAny(deps.repoRoot);
  const git = existsSync(join(deps.repoRoot, ".git"))
    ? createGitOps({ repoRoot: deps.repoRoot })
    : null;
  const http = await createHttpApi({
    readModel: createReadModel({
      repoRoot: deps.repoRoot,
      mode: "snapshot",
      versions: deps.versions,
      prototypeUrl: () => prototypeUrl(prototype),
      runs,
      usage: () => runs().at(-1)?.usage ?? new Map(),
      git,
    }),
    installToken: deps.installToken,
    sessions,
    assets: deps.assets,
    repoRoot: deps.repoRoot,
    ingest: null,
    subscribe: null,
    secrets: dotenvSecrets(deps.repoRoot),
    now,
  });
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let closing: Promise<void> | null = null;
  const snapshot: RunningSnapshot = {
    port: http.port,
    prototypePort: prototype?.port ?? null,
    closed,
    close: () =>
      (closing ??= (async () => {
        await http.close();
        await prototype?.close();
        resolveClosed();
      })()),
    mintNonce: () => sessions.mintNonce(),
  };
  return snapshot;
};
