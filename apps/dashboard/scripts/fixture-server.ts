/**
 * Dev fixture server (AD-5 rule 8): serves the golden run's recorded read routes
 * (`fixtures/golden-run/api/*.json`), replays `events.jsonl` as the SSE stream, accepts any
 * well-formed nonce on `POST /api/session`, and (with `--static <dir>`) serves the built export by
 * the engine's own AD-20 rules (`resolveDashboardAsset`, `dashboardAssetHeaders`).
 *
 *   pnpm build && pnpm dev:fixtures --static out      # the real export on http://127.0.0.1:4310/
 *   pnpm dev:fixtures & pnpm dev                       # next dev proxies /api/* here
 *
 * It also serves the dashboard's own dev fixtures (`dev-fixtures/`, `dev-fixtures.ts`): an evidence
 * bundle, `screens.yaml` and the design-review pins through the artifacts route, takes
 * `POST /api/design/reviews` (validated, kept in memory), and serves the sample prototype on its
 * own origin (port + 1) with `PROTOTYPE_CSP`, reported as `HealthResult.prototype_url`.
 *
 * Flags: --port <n> (4310), --static <dir>, --live (report `mode: live` instead of the recorded
 * snapshot), --replay-ms <n> (delay between replayed events, 600). Binds 127.0.0.1 only and, like
 * the engine (AD-5 rules 3 and 9), refuses a foreign `Host` (both listeners) or `Origin` (the API:
 * its own origin or `next dev`'s). Dev only: it checks no token and is never part of the build.
 */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";
import {
  dashboardAssetHeaders,
  DESIGN_REVIEW_MAX_BYTES,
  DesignReviewCommentInputSchema,
  PROTOTYPE_CSP,
  resolveDashboardAsset,
} from "@vtc/shared";
import {
  artifactContent,
  DEV_PROTOTYPE_DIR,
  devArtifact,
  devArtifactFile,
  mediaTypeFor,
} from "./dev-fixtures.ts";
import {
  checkLoopbackRequest,
  DEV_DASHBOARD_PORT,
  prototypeFile,
  readLimitedBody,
} from "./dev-http.ts";
import { fixtureNameFor, GOLDEN_RUN } from "./fixture-routes.ts";

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
const prototypePort = port + 1;
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

/** Design-review pins posted in this session, by screen (appended to the fixture's file). */
const pins = new Map<string, string[]>();
/** Pins kept per screen (oldest dropped first), so a long dev session cannot grow without bound. */
const MAX_PINS_PER_SCREEN = 200;

const designReviewsArtifact = (path: string): ReturnType<typeof devArtifact> => {
  const match = /^\.vtc\/design\/reviews\/([a-z0-9][a-z0-9._-]{0,63})\.jsonl$/.exec(path);
  if (match?.[1] === undefined) return null;
  const file = devArtifactFile(path);
  const lines = [
    ...(file === null
      ? []
      : readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l !== "")),
    ...(pins.get(match[1]) ?? []),
  ];
  return lines.length === 0 ? null : artifactContent(GOLDEN_RUN, path, `${lines.join("\n")}\n`);
};

const postDesignReview = (body: string | null, res: ServerResponse): void => {
  if (body === null) {
    sendJson(res, 413, { error: { code: "payload_too_large", message: "body too large" } });
    return;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    raw = null;
  }
  const parsed = DesignReviewCommentInputSchema.safeParse(raw);
  if (!parsed.success) {
    sendJson(res, 400, { error: { code: "bad_request", message: "not a design review comment" } });
    return;
  }
  const { screen } = parsed.data;
  pins.set(
    screen,
    [...(pins.get(screen) ?? []), JSON.stringify(parsed.data)].slice(-MAX_PINS_PER_SCREEN),
  );
  sendJson(res, 200, { ok: true, path: `.vtc/design/reviews/${screen}.jsonl` });
};

/** The sample prototype: any path serves its file, or `index.html` (one page per screen route). */
const prototypeServer = createServer((req, res) => {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  if (checkLoopbackRequest({ host: req.headers.host }, prototypePort, []) !== null) {
    res.writeHead(403, { "content-security-policy": PROTOTYPE_CSP });
    res.end();
    return;
  }
  const served = prototypeFile(DEV_PROTOTYPE_DIR, pathname);
  if (served === null) {
    res.writeHead(400, { "content-security-policy": PROTOTYPE_CSP });
    res.end();
    return;
  }
  if (req.method !== "GET" || pathname.startsWith("/api/")) {
    res.writeHead(404, { "content-security-policy": PROTOTYPE_CSP });
    res.end();
    return;
  }
  res.writeHead(200, {
    "content-type": mediaTypeFor(served),
    "content-security-policy": PROTOTYPE_CSP,
    "x-content-type-options": "nosniff",
  });
  res.end(readFileSync(served));
});

const server = createServer((req, res) => {
  const refused = checkLoopbackRequest(req.headers, port, [port, DEV_DASHBOARD_PORT]);
  if (refused !== null) {
    sendJson(res, 403, { error: { code: "forbidden", message: refused } });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const method = req.method ?? "GET";
  if (method === "POST" && url.pathname === "/api/session") {
    sendJson(res, 200, {
      session: randomBytes(32).toString("base64url"),
      expires_at: new Date(Date.now() + 12 * 3_600_000).toISOString(),
    });
    return;
  }
  if (method === "POST" && url.pathname === "/api/design/reviews") {
    readLimitedBody(req, DESIGN_REVIEW_MAX_BYTES).then(
      (body) => {
        postDesignReview(body, res);
      },
      () => {
        res.destroy();
      },
    );
    return;
  }
  if (method === "GET" && url.pathname === `/api/runs/${GOLDEN_RUN}/artifacts`) {
    const path = url.searchParams.get("path") ?? "";
    const extra = designReviewsArtifact(path) ?? devArtifact(GOLDEN_RUN, path);
    if (extra !== null) {
      sendJson(res, 200, extra);
      return;
    }
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
    const health = {
      ...body,
      ...(live ? { mode: "live" } : {}),
      prototype_url: `http://127.0.0.1:${String(prototypePort)}/`,
    };
    sendJson(res, 200, name === "health" ? health : body);
    return;
  }
  if (method !== "GET") {
    notFound(res);
    return;
  }
  serveStatic(res, url.pathname);
});

prototypeServer.listen(prototypePort, "127.0.0.1");

server.listen(port, "127.0.0.1", () => {
  console.warn(
    `fixture server on http://127.0.0.1:${String(port)}/ (golden-1${live ? ", live" : ""}${staticDir === null ? "" : `, static ${staticDir}`}), prototype on :${String(prototypePort)}`,
  );
});
