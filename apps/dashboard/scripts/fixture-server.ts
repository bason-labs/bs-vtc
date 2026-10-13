/**
 * Dev fixture server (AD-5 rule 8): serves the golden run's recorded read routes
 * (`fixtures/golden-run/api/*.json`), replays `events.jsonl` as the SSE stream, accepts any
 * well-formed nonce on `POST /api/session`, and (with `--static <dir>`) serves the built export by
 * the engine's own AD-20 rules (`resolveDashboardAsset`, `dashboardAssetHeaders`).
 *
 *   pnpm build && pnpm dev:fixtures --static out      # the real export on http://127.0.0.1:4310/
 *   pnpm dev:fixtures & pnpm dev                       # next dev proxies /api/* here
 *
 * Flags: --port <n> (4310), --static <dir>, --live (report `mode: live` instead of the recorded
 * snapshot), --replay-ms <n> (delay between replayed events, 600). Binds 127.0.0.1 only. Dev only:
 * it checks no token and is never part of the build.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import { dashboardAssetHeaders, resolveDashboardAsset } from "@vtc/shared";
import { fixtureNameFor } from "./fixture-routes.ts";

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};
const port = Number(flag("port") ?? "4310");
const staticDir =
  flag("static") === undefined ? null : resolve(process.cwd(), flag("static") ?? "");
const replayMs = Number(flag("replay-ms") ?? "600");
const live = args.includes("--live");
const fixtures = resolve(import.meta.dirname, "../../../fixtures/golden-run");

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    "content-type": "application/json",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(body));
};

const notFound = (res: ServerResponse): void => {
  sendJson(res, 404, { error: { code: "not_found", message: "not in the golden-run fixture" } });
};

const events = readFileSync(join(fixtures, "events.jsonl"), "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "");

const lastSeq = (header: string | string[] | undefined): number => {
  const value = Array.isArray(header) ? header[0] : header;
  const seq = Number(value?.split(":").at(-1));
  return Number.isInteger(seq) && seq > 0 ? seq : 0;
};

const stream = (res: ServerResponse, after: number): void => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  let index = after;
  const timer = setInterval(() => {
    const line = events[index];
    if (line === undefined) {
      res.write(": idle\n\n");
      return;
    }
    const event = JSON.parse(line) as { run: string; seq: number };
    res.write(`id: ${event.run}:${String(event.seq)}\ndata: ${line}\n\n`);
    index += 1;
  }, replayMs);
  res.on("close", () => {
    clearInterval(timer);
  });
};

const serveStatic = (res: ServerResponse, pathname: string): void => {
  if (staticDir === null) {
    notFound(res);
    return;
  }
  const has = (path: string): boolean => {
    const file = join(staticDir, path);
    return existsSync(file) && statSync(file).isFile();
  };
  const asset = resolveDashboardAsset(pathname, has);
  if (asset === null) {
    notFound(res);
    return;
  }
  res.writeHead(200, dashboardAssetHeaders(asset));
  res.end(readFileSync(join(staticDir, asset)));
};

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  if (method === "POST" && url.pathname === "/api/session") {
    sendJson(res, 200, {
      session: randomBytes(32).toString("base64url"),
      expires_at: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    });
    return;
  }
  if (method === "GET" && url.pathname === "/api/stream") {
    stream(res, lastSeq(req.headers["last-event-id"]));
    return;
  }
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
    const name = fixtureNameFor(method, `${url.pathname}${url.search}`);
    const file = name === null ? null : join(fixtures, "api", `${name}.json`);
    if (file === null || !existsSync(file)) {
      notFound(res);
      return;
    }
    const body = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    sendJson(res, 200, name === "health" && live ? { ...body, mode: "live" } : body);
    return;
  }
  if (method !== "GET") {
    notFound(res);
    return;
  }
  serveStatic(res, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  console.warn(
    `fixture server on http://127.0.0.1:${String(port)}/ (golden-1${live ? ", live" : ""}${staticDir === null ? "" : `, static ${staticDir}`})`,
  );
});
