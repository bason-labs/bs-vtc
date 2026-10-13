/**
 * The localhost HTTP/SSE API (AD-5; routes frozen in `ENGINE_HTTP`): bound to 127.0.0.1 only;
 * Host must be the server's own and Origin, when present, its own origin, otherwise 403; tokens in
 * the Authorization header, never cookies; no CORS headers; two size-limited, validated data
 * writes; the dashboard's static export at `/` (AD-20). A transport over the engine's read model.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import {
  CONTRACT_SCHEMAS,
  dashboardAssetHeaders,
  ENGINE_HTTP,
  EVENT_PAGE_LIMIT,
  parseSseEventId,
  redactJson,
  resolveDashboardAsset,
  sseEventId,
  type AssetBundle,
  type ContractName,
  type DesignReviewCommentInput,
  type HttpError,
  type StatuslineIngest,
  type VtcEvent,
} from "@vtc/shared";
import type { ReadModel, ReadResult } from "../core/index.js";
import { appendRepoFile, UnsafePathError } from "../git/index.js";
import { sameSecret, type SessionStore } from "./sessions.js";

type RouteName = keyof typeof ENGINE_HTTP.routes;
type Route = (typeof ENGINE_HTTP.routes)[RouteName];

export interface HttpApiOptions {
  readonly readModel: ReadModel;
  readonly installToken: string;
  readonly sessions: SessionStore;
  readonly assets: AssetBundle;
  readonly repoRoot: string;
  /** Live mode stores ingested usage; snapshot mode has none and answers `snapshot_mode`. */
  readonly ingest: ((body: StatuslineIngest) => void) | null;
  /** Live events for SSE; snapshot mode passes `null` (the stream then only replays). */
  readonly subscribe: ((listener: (event: VtcEvent) => void) => () => void) | null;
  /** Known secret values to redact from design-review pins (git-tracked, AD-18). */
  readonly secrets: () => readonly string[];
  readonly now?: () => Date;
  /** Port to bind on 127.0.0.1; 0 (default) picks a free one. */
  readonly port?: number;
}

export interface HttpApi {
  readonly port: number;
  readonly server: Server;
  close(): Promise<void>;
}

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
} as const;

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: HttpError["error"]["code"],
    message: string,
  ) {
    super(message);
  }
}

const send = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
};

const sendError = (res: ServerResponse, failure: HttpFailure): void => {
  send(res, failure.status, {
    error: { code: failure.code, message: failure.message.slice(0, 500) },
  });
};

const fromRead = <T>(result: ReadResult<T>): T => {
  if (result.ok) return result.body;
  throw new HttpFailure(result.code === "not_found" ? 404 : 400, result.code, result.message);
};

/** `/api/runs/:run/...` patterns as regular expressions. */
const PATTERNS: readonly [RouteName, RegExp][] = (
  Object.entries(ENGINE_HTTP.routes) as [RouteName, Route][]
).map(([name, route]) => [
  name,
  new RegExp(`^${route.path.replace(/:run/, "(?<run>[^/]+)").replace(/:task/, "(?<task>[^/]+)")}$`),
]);

const matchRoute = (
  method: string,
  pathname: string,
): { name: RouteName; route: Route; params: Record<string, string> } | null => {
  for (const [name, pattern] of PATTERNS) {
    const match = pattern.exec(pathname);
    const route = ENGINE_HTTP.routes[name];
    if (match !== null && route.method === method) {
      const params: Record<string, string> = {};
      for (const [k, v] of Object.entries(match.groups ?? {})) params[k] = decodeURIComponent(v);
      return { name, route, params };
    }
  }
  return null;
};

const readBody = (req: IncomingMessage, limit: number): Promise<string> =>
  new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    // Over the limit: stop reading, answer 413, then close the connection (see the server).
    const tooLarge = (): void => {
      req.pause();
      req.removeAllListeners("data");
      reject(new HttpFailure(413, "payload_too_large", `body larger than ${String(limit)} bytes`));
    };
    if (Number.isFinite(declared) && declared > limit) {
      tooLarge();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        tooLarge();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });

const parseBody = (text: string, contract: ContractName): unknown => {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new HttpFailure(400, "bad_request", "the body is not JSON");
  }
  const parsed = CONTRACT_SCHEMAS[contract].safeParse(raw);
  if (!parsed.success) {
    throw new HttpFailure(
      400,
      "bad_request",
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    );
  }
  return parsed.data;
};

const bearer = (req: IncomingMessage): string | null => {
  const header = req.headers[ENGINE_HTTP.tokenHeader];
  if (typeof header !== "string") return null;
  const match = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(header.trim());
  return match?.[1] ?? null;
};

/** Host must be `127.0.0.1:<port>` or `localhost:<port>`; Origin, when present, our own origin. */
export const checkHostAndOrigin = (req: IncomingMessage, port: number): string | null => {
  const host = req.headers.host;
  const allowed = [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`];
  if (host === undefined || !allowed.includes(host.toLowerCase())) return "foreign Host";
  const origin = req.headers.origin;
  if (origin !== undefined && origin !== `http://${host.toLowerCase()}`) return "foreign Origin";
  return null;
};

export const createHttpApi = async (options: HttpApiOptions): Promise<HttpApi> => {
  const now = options.now ?? (() => new Date());
  let port = 0;
  const streams = new Set<ServerResponse>();

  const authorize = (req: IncomingMessage, route: Route): void => {
    if (route.auth === "nonce") return;
    const token = bearer(req);
    if (token === null) throw new HttpFailure(403, "forbidden", "a bearer token is required");
    const install = sameSecret(token, options.installToken);
    if (route.auth === "install") {
      if (!install) throw new HttpFailure(403, "forbidden", "this route takes the install token");
      return;
    }
    if (!install && !options.sessions.isSession(token))
      throw new HttpFailure(403, "forbidden", "invalid or expired token");
  };

  const stream = (req: IncomingMessage, res: ServerResponse, query: URLSearchParams): void => {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      connection: "keep-alive",
    });
    const write = (event: VtcEvent): void => {
      res.write(
        `id: ${sseEventId(event.run, event.seq)}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`,
      );
    };
    // AD-5 rule 6: `?run=` alone narrows the stream. Last-Event-ID (`<run>:<seq>`) only says
    // where to resume that run's replay; a global stream stays global after a reconnect.
    const last = req.headers["last-event-id"];
    const resume = typeof last === "string" ? parseSseEventId(last) : null;
    const run = query.get("run");
    const replay = (from: string, after: number): void => {
      for (let cursor: number | null = after; cursor !== null;) {
        const page = options.readModel.events(from, cursor, EVENT_PAGE_LIMIT.max);
        if (!page.ok) return;
        for (const event of page.body.events) write(event);
        cursor = page.body.events.length === 0 ? null : page.body.next_after;
      }
    };
    if (run !== null) replay(run, resume?.run === run ? resume.seq : 0);
    else if (resume !== null) replay(resume.run, resume.seq);
    streams.add(res);
    const unsubscribe = options.subscribe?.((event) => {
      if (run === null || event.run === run) write(event);
    });
    const keepAlive = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      unsubscribe?.();
      streams.delete(res);
    });
  };

  const handleApi = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const matched = matchRoute(req.method ?? "GET", url.pathname);
    if (matched === null)
      throw new HttpFailure(404, "not_found", `no route ${req.method ?? ""} ${url.pathname}`);
    const { name, route, params } = matched;
    authorize(req, route);
    const run = params.run ?? "";
    const q = url.searchParams;
    const model = options.readModel;
    switch (name) {
      case "health":
        send(res, 200, model.health());
        return;
      case "status":
        send(res, 200, fromRead(model.status()));
        return;
      case "runs":
        send(res, 200, model.runs());
        return;
      case "runEvents":
        send(
          res,
          200,
          fromRead(
            model.events(
              run,
              Number(q.get("after") ?? "0"),
              Number(q.get("limit") ?? String(EVENT_PAGE_LIMIT.default)),
            ),
          ),
        );
        return;
      case "tasks":
        send(res, 200, fromRead(model.tasks(run)));
        return;
      case "task":
        send(res, 200, fromRead(model.task(run, params.task ?? "")));
        return;
      case "taskDiff":
        send(res, 200, fromRead(await model.taskDiff(run, params.task ?? "")));
        return;
      case "features":
        send(res, 200, fromRead(model.features(run)));
        return;
      case "artifact":
        send(res, 200, fromRead(model.artifact(run, q.get("path") ?? "")));
        return;
      case "graph":
        send(
          res,
          200,
          fromRead(model.graph(run, q.get("scope") ?? "project", q.get("task") ?? undefined)),
        );
        return;
      case "escalations":
        send(res, 200, fromRead(model.escalations(run)));
        return;
      case "usage":
        send(res, 200, model.usage());
        return;
      case "stream":
        stream(req, res, q);
        return;
      case "sessionNonce":
        await readBody(req, ENGINE_HTTP.routes.sessionNonce.maxBodyBytes);
        send(res, 200, options.sessions.mintNonce());
        return;
      case "session": {
        const body = parseBody(
          await readBody(req, ENGINE_HTTP.routes.session.maxBodyBytes),
          "SessionExchangeInput",
        ) as { nonce: string };
        const session = options.sessions.exchange(body.nonce);
        if (session === null)
          throw new HttpFailure(403, "forbidden", "the nonce is unknown, used or expired");
        send(res, 200, session);
        return;
      }
      case "statuslineIngest": {
        const body = parseBody(
          await readBody(req, ENGINE_HTTP.routes.statuslineIngest.maxBodyBytes),
          "StatuslineIngest",
        ) as StatuslineIngest;
        if (options.ingest === null)
          throw new HttpFailure(
            409,
            "snapshot_mode",
            "no engine is running: the dashboard serves a snapshot",
          );
        options.ingest(body);
        send(res, 200, { ok: true });
        return;
      }
      case "designReviews": {
        const body = parseBody(
          await readBody(req, ENGINE_HTTP.routes.designReviews.maxBodyBytes),
          "DesignReviewCommentInput",
        ) as DesignReviewCommentInput;
        const path = `.vtc/design/reviews/${body.screen}.jsonl`;
        try {
          // An agent can plant a symlink under .vtc/design/: refused, never followed.
          appendRepoFile(
            options.repoRoot,
            path,
            `${JSON.stringify(redactJson({ ...body, at: now().toISOString() }, options.secrets()))}\n`,
          );
        } catch (error) {
          if (error instanceof UnsafePathError)
            throw new HttpFailure(400, "bad_request", "the review file is not a plain file");
          throw error;
        }
        send(res, 200, { ok: true, path });
        return;
      }
    }
  };

  const handleAsset = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    if (req.method !== "GET" && req.method !== "HEAD")
      throw new HttpFailure(404, "not_found", "not found");
    const asset = resolveDashboardAsset(
      url.pathname,
      (p) => options.assets.read("dashboard", p) !== undefined,
    );
    const bytes = asset === null ? undefined : options.assets.read("dashboard", asset);
    if (asset === null || bytes === undefined) throw new HttpFailure(404, "not_found", "not found");
    res.writeHead(200, { ...dashboardAssetHeaders(asset), "content-length": String(bytes.length) });
    res.end(req.method === "HEAD" ? undefined : Buffer.from(bytes));
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const problem = checkHostAndOrigin(req, port);
        if (problem !== null) throw new HttpFailure(403, "forbidden", problem);
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
        if (url.pathname === "/api" || url.pathname.startsWith("/api/"))
          await handleApi(req, res, url);
        else handleAsset(req, res, url);
      } catch (error) {
        if (error instanceof HttpFailure && error.status === 413) {
          // The unread rest of an oversized body is never drained: close once 413 is out.
          if (!res.headersSent) res.setHeader("connection", "close");
          res.once("finish", () => req.destroy());
        }
        sendError(
          res,
          error instanceof HttpFailure
            ? error
            : new HttpFailure(
                500,
                "internal",
                error instanceof Error ? error.message : "internal error",
              ),
        );
      }
    })();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, ENGINE_HTTP.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of streams) res.end();
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
