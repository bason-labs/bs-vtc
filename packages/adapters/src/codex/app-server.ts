/**
 * The managed `codex app-server` child (§6.9, AD-6 rule 4): the sanctioned Codex usage source.
 * JSON-RPC over stdio, one JSON message per line (spike 1): `initialize` → `initialized` →
 * `account/rateLimits/read`; `account/rateLimits/updated` notifications push changes. Codex
 * signs in by itself; VTC never touches its credentials. Unknown notifications
 * (`account/updated`, `remoteControl/status/changed`, …) are ignored, and requests from the
 * server are declined, since VTC starts no turns here.
 */
import { createInterface } from "node:readline";
import type { UsageSnapshot } from "@vtc/shared";
import { isRecord, parseJsonObject, text } from "../common/json.js";
import type { Spawner, SpawnedProcess } from "../common/process.js";
import { codexUsageFromRateLimits } from "./rate-limits.js";

export const APP_SERVER_COMMAND = { command: "codex", args: ["app-server"], env: {} } as const;

const READ_METHOD = "account/rateLimits/read";
const UPDATED_METHOD = "account/rateLimits/updated";

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface Connection {
  readonly ready: Promise<void>;
  alive(): boolean;
  request(method: string, params?: unknown): Promise<unknown>;
  close(): Promise<void>;
}

interface ConnectionOptions {
  readonly spawner: Spawner;
  readonly cwd: string;
  readonly clientVersion: string;
  readonly requestTimeoutMs: number;
  readonly killGraceMs: number;
  readonly onNotification: (method: string, params: unknown) => void;
}

const rpcError = (value: unknown): Error => {
  const message = isRecord(value) ? text(value.message) : null;
  return new Error(`codex app-server: ${message ?? "request failed"}`);
};

const openConnection = (options: ConnectionOptions): Connection => {
  const child: SpawnedProcess = options.spawner(APP_SERVER_COMMAND, {
    cwd: options.cwd,
    stdin: "pipe",
  });
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let alive = true;
  child.stderr.resume();
  // a write after the child died must not crash the engine
  child.stdin?.on("error", () => undefined);

  const send = (message: Record<string, unknown>): void => {
    if (alive) child.stdin?.write(`${JSON.stringify(message)}\n`);
  };

  const failAll = (error: Error): void => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
  };

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    const message = parseJsonObject(line);
    if (message === null) return;
    const method = text(message.method);
    const id = message.id;
    if (method !== null && id !== undefined) {
      send({ id, error: { code: -32601, message: `vtc does not handle ${method}` } });
    } else if (method !== null) {
      options.onNotification(method, message.params);
    } else if (typeof id === "number") {
      const entry = pending.get(id);
      if (entry === undefined) return;
      pending.delete(id);
      clearTimeout(entry.timer);
      if (message.error !== undefined) entry.reject(rpcError(message.error));
      else entry.resolve(message.result);
    }
  });

  const exited = child.exited.then((exit) => {
    alive = false;
    reader.close();
    failAll(
      new Error(
        exit.error === null
          ? `codex app-server exited (${String(exit.code ?? exit.signal)})`
          : `codex app-server is not available: ${exit.error.message}`,
      ),
    );
  });

  const request = (method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!alive) {
        reject(new Error("codex app-server is not running"));
        return;
      }
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`codex app-server did not answer ${method} in time`));
      }, options.requestTimeoutMs);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      send({ id, method, ...(params === undefined ? {} : { params }) });
    });

  const ready = request("initialize", {
    clientInfo: { name: "vtc", title: "VTC", version: options.clientVersion },
  }).then(() => {
    send({ method: "initialized" });
  });

  return {
    ready,
    alive: () => alive,
    request,
    async close() {
      if (!alive) {
        await exited;
        return;
      }
      child.stdin?.end();
      child.kill("SIGTERM");
      const kill = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.killGraceMs);
      kill.unref();
      await exited;
      clearTimeout(kill);
    },
  };
};

export interface CodexUsageSourceOptions {
  readonly spawner: Spawner;
  readonly now: () => Date;
  /** Working directory of the app-server child. */
  readonly cwd: string;
  readonly clientVersion: string;
  readonly requestTimeoutMs?: number;
  /**
   * How often a watched source re-reads (the `updated` notification has not been observed yet,
   * spine §7). A dead child is restarted on the next read.
   */
  readonly pollMs?: number;
  readonly killGraceMs?: number;
}

export interface CodexUsageSource {
  read(): Promise<UsageSnapshot>;
  watch(onUpdate: (snapshot: UsageSnapshot) => void): () => void;
  dispose(): Promise<void>;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_MS = 120_000;
const DEFAULT_KILL_GRACE_MS = 3_000;

export const createCodexUsageSource = (options: CodexUsageSourceOptions): CodexUsageSource => {
  const watchers = new Set<(snapshot: UsageSnapshot) => void>();
  let connection: Connection | null = null;
  let poll: NodeJS.Timeout | undefined;
  let disposed = false;

  const emit = (snapshot: UsageSnapshot): void => {
    for (const watcher of watchers) watcher(snapshot);
  };

  const onNotification = (method: string, params: unknown): void => {
    if (method === UPDATED_METHOD) {
      emit(codexUsageFromRateLimits(params, options.now().toISOString()));
    }
  };

  const connect = async (): Promise<Connection> => {
    if (disposed) throw new Error("the codex usage source was disposed");
    if (connection === null || !connection.alive()) {
      connection = openConnection({
        spawner: options.spawner,
        cwd: options.cwd,
        clientVersion: options.clientVersion,
        requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        killGraceMs: options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
        onNotification,
      });
    }
    const current = connection;
    try {
      await current.ready;
    } catch (error) {
      if (connection === current) connection = null;
      await current.close();
      throw error;
    }
    return current;
  };

  const read = async (): Promise<UsageSnapshot> => {
    let current = await connect();
    let result: unknown;
    try {
      result = await current.request(READ_METHOD);
    } catch (error) {
      // the child died between the handshake and the read: start a fresh one, once
      if (current.alive()) throw error;
      current = await connect();
      result = await current.request(READ_METHOD);
    }
    return codexUsageFromRateLimits(result, options.now().toISOString());
  };

  const refresh = (): void => {
    read().then(emit, () => undefined);
  };

  return {
    read,
    watch(onUpdate) {
      if (disposed) return () => undefined;
      watchers.add(onUpdate);
      if (poll === undefined) {
        poll = setInterval(refresh, options.pollMs ?? DEFAULT_POLL_MS);
        poll.unref();
      }
      refresh();
      return () => {
        watchers.delete(onUpdate);
        if (watchers.size === 0 && poll !== undefined) {
          clearInterval(poll);
          poll = undefined;
        }
      };
    },
    async dispose() {
      disposed = true;
      watchers.clear();
      if (poll !== undefined) clearInterval(poll);
      poll = undefined;
      const current = connection;
      connection = null;
      await current?.close();
    },
  };
};
