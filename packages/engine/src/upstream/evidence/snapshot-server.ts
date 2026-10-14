/**
 * The evidence snapshot server (AD-27 rule 6; spine §5 reading 208 (4)), ported from the
 * dashboard's dev fixture server: the only origin the evidence browser may reach. It serves a
 * frozen, redacted snapshot of read routes, the run's events replayed as SSE, extra evidence pages
 * (the rendered gate report) and the dashboard export from the `AssetBundle` by the engine's own
 * AD-20 rules (`resolveDashboardAsset`, `dashboardAssetHeaders`). It never talks to the live engine
 * API and checks no token because it holds nothing a token would protect. It binds 127.0.0.1 on an
 * ephemeral port, refuses a foreign `Host` or `Origin` (AD-5 rule 3), answers GET only (plus a
 * nonce on `POST /api/session`, which the dashboard asks for), and lives only for one capture.
 */
import { randomBytes } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  dashboardAssetHeaders,
  redactJson,
  resolveDashboardAsset,
  type AssetBundle,
} from "@vtc/shared";

export interface SnapshotServerOptions {
  /** The dashboard export (`AssetBundle` namespace `dashboard`). */
  readonly assets: AssetBundle;
  /** Read routes by `pathname` or `pathname?search` → JSON body. Redacted here. */
  readonly routes: Readonly<Record<string, unknown>>;
  /** The run's events, replayed in order as SSE on `/api/stream`. Redacted here. */
  readonly events: readonly unknown[];
  /** Milliseconds between replayed events (see {@link replayIntervalMs}). */
  readonly replayMs: number;
  /** Known secret values `redactJson` removes from routes and events. */
  readonly knownValues: readonly string[];
  /** Extra pages under `/evidence/<name>` (the rendered gate report). */
  readonly files?: Readonly<Record<string, Uint8Array>>;
}

export interface SnapshotServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  close(): Promise<void>;
}

/** Pure: a replay speed that fits the run in about 25 s (40–600 ms per event). */
export const replayIntervalMs = (events: number): number =>
  Math.min(600, Math.max(40, Math.round(25_000 / Math.max(1, events))));

const oneHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? (value.length === 1 ? value[0] : "") : value;

/** `null` when `Host` is this server's loopback address and `Origin` is absent or its own. */
export const loopbackRefusal = (headers: IncomingHttpHeaders, port: number): string | null => {
  const allowed = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
  const host = oneHeader(headers.host)?.toLowerCase();
  if (host === undefined || !allowed.includes(host)) return "Host is not this server";
  const origin = oneHeader(headers.origin);
  if (origin !== undefined && !allowed.some((h) => origin === `http://${h}`)) {
    return "Origin is not allowed";
  }
  return null;
};

const EVIDENCE_FILE = /^\/evidence\/([a-z0-9][a-z0-9._-]{0,80})$/;

export const startSnapshotServer = async (
  options: SnapshotServerOptions,
): Promise<SnapshotServer> => {
  const routes = redactJson({ ...options.routes }, options.knownValues);
  const events = redactJson([...options.events], options.knownValues).map((e) => JSON.stringify(e));
  const files = options.files ?? {};
  const streams = new Set<ServerResponse>();
  const timers = new Set<NodeJS.Timeout>();

  const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, {
      "content-type": "application/json",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(body));
  };
  const notFound = (res: ServerResponse): void => {
    sendJson(res, 404, { error: { code: "not_found", message: "not in the evidence snapshot" } });
  };

  const stream = (res: ServerResponse): void => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    streams.add(res);
    let index = 0;
    const timer = setInterval(() => {
      const line = events[index];
      if (line === undefined) {
        res.write(": idle\n\n");
        return;
      }
      const event = JSON.parse(line) as { run?: unknown; seq?: unknown };
      res.write(`id: ${String(event.run)}:${String(event.seq)}\ndata: ${line}\n\n`);
      index += 1;
    }, options.replayMs);
    timers.add(timer);
    res.on("close", () => {
      clearInterval(timer);
      timers.delete(timer);
      streams.delete(res);
    });
  };

  const server = createServer((req, res) => {
    const address = server.address() as AddressInfo;
    const refused = loopbackRefusal(req.headers, address.port);
    if (refused !== null) {
      sendJson(res, 403, { error: { code: "forbidden", message: refused } });
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    if (method === "POST" && url.pathname === "/api/session") {
      sendJson(res, 200, {
        session: randomBytes(32).toString("base64url"),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return;
    }
    if (method !== "GET") {
      sendJson(res, 405, { error: { code: "method_not_allowed", message: "read-only snapshot" } });
      return;
    }
    if (url.pathname === "/api/stream") {
      stream(res);
      return;
    }
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      const key = `${url.pathname}${url.search}`;
      const body = routes[key] ?? routes[url.pathname];
      if (body === undefined) {
        notFound(res);
        return;
      }
      sendJson(res, 200, body);
      return;
    }
    const evidence = EVIDENCE_FILE.exec(url.pathname);
    if (evidence?.[1] !== undefined) {
      const bytes = files[evidence[1]];
      if (bytes === undefined) {
        notFound(res);
        return;
      }
      res.writeHead(200, dashboardAssetHeaders(evidence[1]));
      res.end(bytes);
      return;
    }
    const asset = resolveDashboardAsset(
      url.pathname,
      (path) => options.assets.read("dashboard", path) !== undefined,
    );
    const bytes = asset === null ? undefined : options.assets.read("dashboard", asset);
    if (asset === null || bytes === undefined) {
      notFound(res);
      return;
    }
    res.writeHead(200, dashboardAssetHeaders(asset));
    res.end(bytes);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${String(port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearInterval(timer);
        for (const res of streams) res.destroy();
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      }),
  };
};
