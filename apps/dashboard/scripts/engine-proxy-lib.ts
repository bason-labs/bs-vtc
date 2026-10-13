/**
 * Dev-only proxy from `next dev` to a live engine (AD-5 rule 8). `next dev` rewrites `/api/*` to
 * this proxy (`VTC_DEV_API`), which forwards each request the dashboard may make to the engine
 * found in `~/.vtc/engines/<repo-key>.json`, with the install token injected, `Host` set to the
 * engine's and `Origin` dropped, so the browser sees one origin and the engine's own checks stay
 * unchanged. It binds 127.0.0.1 only, forwards only the routes whose `auth` is `token`
 * (never the install-only nonce mint or statusline ingest), and never logs or returns the token.
 *
 * Because it drops `Origin` and rewrites `Host`, the engine's AD-5 rule 3 checks cannot see who
 * asked, so the proxy makes them itself before anything else (`checkDevRequest`): `Host` must be
 * the proxy's own loopback address, and `X-Forwarded-Host` (set by `next dev`) and `Origin`, when
 * present, must be the `next dev` origin. A DNS-rebinding page or a LAN client gets `403` and the
 * engine is never contacted.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import {
  createServer,
  request,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ENGINE_HTTP,
  ENGINE_INSTANCE,
  engineDiscoveryFile,
  EngineDiscoverySchema,
  type EngineDiscovery,
} from "@vtc/shared";
import { DEV_DASHBOARD_PORT, isLoopbackHost, isLoopbackOrigin, oneHeader } from "./dev-http.ts";

/** `$VTC_HOME`, else `~/.vtc` (the cli's rule). */
export const resolveVtcHome = (env: Readonly<Record<string, string | undefined>>): string =>
  env.VTC_HOME !== undefined && env.VTC_HOME !== "" ? env.VTC_HOME : join(homedir(), ".vtc");

/** The running engine for `repoRoot`, or `null` when none has published a discovery file. */
export const readEngineDiscovery = (vtcHome: string, repoRoot: string): EngineDiscovery | null => {
  let text: string;
  try {
    text = readFileSync(join(vtcHome, engineDiscoveryFile(repoRoot)), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = EngineDiscoverySchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The install token, with the cli's checks: refused when group or others can read the file
 * (on POSIX), when it is a symlink, or when it does not hold a token. The mode check and the read
 * use one descriptor, so they see the same file. Errors never include the value.
 */
export const readDevInstallToken = (vtcHome: string): string => {
  const path = join(vtcHome, ENGINE_INSTANCE.tokenFile);
  // O_NOFOLLOW: a symlinked token file is refused (Windows has no such flag).
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(path, constants.O_RDONLY | noFollow);
  try {
    if (process.platform !== "win32" && (fstatSync(fd).mode & 0o077) !== 0) {
      throw new Error(`${path} is readable by other users; remove it and run vtc install`);
    }
    const token = readFileSync(fd, "utf8").trim();
    if (!TOKEN.test(token)) throw new Error(`${path} does not hold a vtc install token`);
    return token;
  } finally {
    closeSync(fd);
  }
};

/**
 * AD-5 rule 3, made by the proxy on the engine's behalf (it drops `Origin` and sets `Host`):
 * `null` when the request may be forwarded, else why it is refused.
 */
export const checkDevRequest = (
  headers: IncomingHttpHeaders,
  proxyPort: number,
  devPort: number,
): string | null => {
  if (!isLoopbackHost(oneHeader(headers.host), proxyPort)) return "Host is not this proxy";
  const forwardedHost = oneHeader(headers["x-forwarded-host"]);
  if (forwardedHost !== undefined && !isLoopbackHost(forwardedHost, devPort)) {
    return "X-Forwarded-Host is not the next dev origin";
  }
  const origin = oneHeader(headers.origin);
  if (origin !== undefined && !isLoopbackOrigin(origin, devPort)) {
    return "Origin is not the next dev origin";
  }
  return null;
};

const ROUTES = Object.values(ENGINE_HTTP.routes)
  .filter((r) => r.auth === "token")
  .map((r) => ({
    method: r.method,
    pattern: new RegExp(`^${r.path.replace(/:(run|task)\b/g, "[^/?#]+")}$`),
  }));

/** True for the dashboard's routes (`auth: token`); the install-only and nonce routes are not proxied. */
export const isProxiedRoute = (method: string, pathname: string): boolean =>
  ROUTES.some((r) => r.method === method && r.pattern.test(pathname));

const DROPPED = new Set([
  "host",
  "origin",
  "referer",
  "cookie",
  "authorization",
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
]);

/** The request headers sent on to the engine. */
export const engineRequestHeaders = (
  incoming: IncomingHttpHeaders,
  port: number,
  token: string,
): Record<string, string | string[]> => {
  const out: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !DROPPED.has(name.toLowerCase())) out[name] = value;
  }
  out.host = `${ENGINE_HTTP.bindHost}:${String(port)}`;
  out.authorization = `${ENGINE_HTTP.tokenScheme} ${token}`;
  return out;
};

export interface EngineProxyOptions {
  readonly vtcHome: string;
  /** Absolute root of the repo whose engine to reach. */
  readonly repoRoot: string;
  /** The `next dev` port whose origin may call (default {@link DEV_DASHBOARD_PORT}). */
  readonly devPort?: number;
}

const sendError = (
  res: ServerResponse,
  status: number,
  code: "not_found" | "forbidden" | "internal",
  message: string,
): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
};

/** The proxy server; call `listen(port, "127.0.0.1")` on it. */
export const createEngineProxy = (options: EngineProxyOptions): Server =>
  createServer((req, res) => {
    const method = req.method ?? "GET";
    const refused = checkDevRequest(
      req.headers,
      req.socket.localPort ?? 0,
      options.devPort ?? DEV_DASHBOARD_PORT,
    );
    if (refused !== null) {
      sendError(res, 403, "forbidden", refused);
      return;
    }
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (!isProxiedRoute(method, url.pathname)) {
      sendError(res, 404, "not_found", "the dev proxy forwards only the dashboard's routes");
      return;
    }
    const engine = readEngineDiscovery(options.vtcHome, options.repoRoot);
    if (engine === null) {
      sendError(res, 502, "internal", `no engine is running for ${options.repoRoot}`);
      return;
    }
    let token: string;
    try {
      token = readDevInstallToken(options.vtcHome);
    } catch (error) {
      sendError(res, 500, "internal", error instanceof Error ? error.message : "no install token");
      return;
    }
    const upstream = request(
      {
        host: ENGINE_HTTP.bindHost,
        port: engine.port,
        method,
        path: `${url.pathname}${url.search}`,
        headers: engineRequestHeaders(req.headers, engine.port, token),
      },
      (answer) => {
        const headers = { ...answer.headers };
        delete headers.connection;
        delete headers["keep-alive"];
        delete headers["transfer-encoding"];
        res.writeHead(answer.statusCode ?? 502, headers);
        answer.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (res.headersSent) res.destroy();
      else
        sendError(
          res,
          502,
          "internal",
          `the engine on port ${String(engine.port)} is not answering`,
        );
    });
    res.on("close", () => {
      upstream.destroy();
    });
    req.pipe(upstream);
  });
