/**
 * Small HTTP helpers shared by the dev-only servers (`fixture-server.ts`, `engine-proxy-lib.ts`),
 * so they refuse what the engine refuses (AD-5 rules 3 and 9): foreign `Host`/`Origin`, oversized
 * bodies, and prototype paths outside the prototype directory.
 */
import { existsSync, statSync } from "node:fs";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import { join, normalize, sep } from "node:path";

/** The port `next dev` serves the dashboard on (`pnpm dev`). */
export const DEV_DASHBOARD_PORT = 4300;

/** The one value of a header, `""` when it was sent more than once (never matches anything). */
export const oneHeader = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? (value.length === 1 ? value[0] : "") : value;

/** `127.0.0.1:<port>` or `localhost:<port>` (case-insensitive), nothing else. */
export const isLoopbackHost = (host: string | undefined, port: number): boolean =>
  host !== undefined &&
  [`127.0.0.1:${String(port)}`, `localhost:${String(port)}`].includes(host.toLowerCase());

/** `http://127.0.0.1:<port>` or `http://localhost:<port>` exactly (no path, no https). */
export const isLoopbackOrigin = (origin: string, port: number): boolean => {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return url.protocol === "http:" && url.origin === origin && isLoopbackHost(url.host, port);
};

/**
 * AD-5 rule 3 for a dev server on `port`: `Host` must be its own loopback address, and `Origin`,
 * when present, one of `origins` (ports whose loopback origins may call). `null` = allowed.
 */
export const checkLoopbackRequest = (
  headers: IncomingHttpHeaders,
  port: number,
  originPorts: readonly number[],
): string | null => {
  if (!isLoopbackHost(oneHeader(headers.host), port)) return "Host is not this server";
  const origin = oneHeader(headers.origin);
  if (origin !== undefined && !originPorts.some((p) => isLoopbackOrigin(origin, p))) {
    return "Origin is not allowed";
  }
  return null;
};

/**
 * The request body, read until `maxBytes` and no further: `null` (and the request is no longer
 * read) once it is larger, so the limit caps memory, not just what is accepted.
 */
export const readLimitedBody = (req: IncomingMessage, maxBytes: number): Promise<string | null> =>
  new Promise((done, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    req.on("data", (chunk: Buffer) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        chunks.length = 0;
        req.pause();
        done(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!over) done(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", fail);
  });

/**
 * The file a prototype request path serves: the file itself when it lies inside `dir`, else
 * `index.html` (one page per screen route). `null` for a path that is not valid percent-encoding.
 */
export const prototypeFile = (dir: string, pathname: string): string | null => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = normalize(join(dir, decoded));
  const inside = file.startsWith(`${dir}${sep}`) || file === dir;
  return inside && existsSync(file) && statSync(file).isFile() ? file : join(dir, "index.html");
};
