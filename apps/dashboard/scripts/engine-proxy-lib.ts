/**
 * Dev-only proxy from `next dev` to a live engine (AD-5 rule 8). `next dev` rewrites `/api/*` to
 * this proxy (`VTC_DEV_API`), which forwards each request the dashboard may make to the engine
 * found in `~/.vtc/engines/<repo-key>.json`, with the install token injected, `Host` set to the
 * engine's and `Origin` dropped, so the browser sees one origin and the engine's own checks stay
 * unchanged. It binds 127.0.0.1 only, forwards only the routes whose `auth` is `token`
 * (never the install-only nonce mint or statusline ingest), and never logs or returns the token.
 */
import { readFileSync, statSync } from "node:fs";
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
 * (on POSIX) or when it does not hold a token. Errors never include the value.
 */
export const readDevInstallToken = (vtcHome: string): string => {
  const path = join(vtcHome, ENGINE_INSTANCE.tokenFile);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users; remove it and run vtc install`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN.test(token)) throw new Error(`${path} does not hold a vtc install token`);
  return token;
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
}

const sendError = (
  res: ServerResponse,
  status: number,
  code: "not_found" | "internal",
  message: string,
): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { code, message } }));
};

/** The proxy server; call `listen(port, "127.0.0.1")` on it. */
export const createEngineProxy = (options: EngineProxyOptions): Server =>
  createServer((req, res) => {
    const method = req.method ?? "GET";
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
