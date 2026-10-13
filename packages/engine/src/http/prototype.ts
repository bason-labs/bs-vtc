/**
 * The prototype origin (AD-5 rule 9): agent-written HTML/JS under `.vtc/design/prototype/` served
 * from its own 127.0.0.1 port, never the API's origin. No token (git-tracked files, no run data),
 * Host checked, `PROTOTYPE_CSP` on every response, no `/api/` route, nothing outside the root.
 * The files are agent-written, so every filesystem error (an unreadable file, a symlink loop, a
 * file removed mid-request) answers 404 or 500; none may escape and stop the daemon. Nothing but a
 * regular file is opened, and the open never blocks (`O_NONBLOCK`): a FIFO or device planted under
 * the root would otherwise hold the daemon's one event loop. Files over {@link MAX_FILE_BYTES}
 * are not served.
 */
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { dashboardAssetHeaders, ENGINE_HTTP } from "@vtc/shared";

/** The largest prototype file served (a prototype page, script or image). */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

export interface PrototypeServer {
  readonly port: number;
  close(): Promise<void>;
}

export const createPrototypeServer = async (
  repoRoot: string,
  port = 0,
): Promise<PrototypeServer> => {
  let bound = 0;
  const root = join(repoRoot, ENGINE_HTTP.prototype.root);
  const fail = (res: ServerResponse, status: number, text: string): void => {
    res.writeHead(status, {
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": ENGINE_HTTP.prototype.csp,
      "x-content-type-options": "nosniff",
    });
    res.end(text);
  };
  /** The resolved file under the root, opened once (`null` = 404). */
  const open = (segments: readonly string[]): { fd: number } | null => {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return null;
    }
    for (const candidate of [join(root, ...segments), join(root, ...segments, "index.html")]) {
      let real: string;
      try {
        real = realpathSync(candidate);
      } catch {
        continue;
      }
      if (real === realRoot) continue; // the root itself: try its index.html
      if (!real.startsWith(`${realRoot}${sep}`)) return null;
      const stat = statSync(real);
      if (stat.isDirectory()) continue;
      if (!stat.isFile()) return null; // a FIFO, socket or device: never opened
      // Non-blocking: the path may have been swapped for a FIFO since the stat.
      const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
      const opened = fstatSync(fd);
      if (opened.isFile() && opened.size <= MAX_FILE_BYTES) return { fd };
      closeSync(fd);
      return null;
    }
    return null;
  };
  const readAll = (fd: number): Buffer => {
    const size = fstatSync(fd).size;
    const buffer = Buffer.alloc(size);
    let read = 0;
    while (read < size) {
      const n = readSync(fd, buffer, read, size - read, read);
      if (n === 0) break;
      read += n;
    }
    return buffer.subarray(0, read);
  };
  const handle = (req: IncomingMessage, res: ServerResponse): void => {
    const host = req.headers.host?.toLowerCase();
    if (host !== `127.0.0.1:${String(bound)}` && host !== `localhost:${String(bound)}`) {
      fail(res, 403, "forbidden");
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(bound)}`);
    if (req.method !== "GET" || url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      fail(res, 404, "not found");
      return;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      fail(res, 400, "bad path");
      return;
    }
    const segments = decoded.split("/").filter((s) => s !== "");
    if (
      decoded.includes("\0") ||
      decoded.includes("\\") ||
      segments.some((s) => s === "." || s === "..")
    ) {
      fail(res, 400, "bad path");
      return;
    }
    const opened = open(segments);
    if (opened === null) {
      fail(res, 404, "not found");
      return;
    }
    let body: Buffer;
    try {
      body = readAll(opened.fd);
    } finally {
      closeSync(opened.fd);
    }
    const headers = dashboardAssetHeaders(segments.join("/") || "index.html");
    res.writeHead(200, {
      "content-type": headers["content-type"] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      "content-security-policy": ENGINE_HTTP.prototype.csp,
    });
    res.end(body);
  };
  const server: Server = createServer((req, res) => {
    try {
      handle(req, res);
    } catch {
      if (res.headersSent) res.destroy();
      else fail(res, 500, "the file could not be read");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, ENGINE_HTTP.prototype.bindHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  bound = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port: bound,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
};
