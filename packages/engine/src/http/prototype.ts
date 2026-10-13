/**
 * The prototype origin (AD-5 rule 9): agent-written HTML/JS under `.vtc/design/prototype/` served
 * from its own 127.0.0.1 port, never the API's origin. No token (git-tracked files, no run data),
 * Host checked, `PROTOTYPE_CSP` on every response, no `/api/` route, nothing outside the root.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { join, sep } from "node:path";
import { dashboardAssetHeaders, ENGINE_HTTP } from "@vtc/shared";

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
  const server: Server = createServer((req, res) => {
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
    let file = join(root, ...segments);
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(root) || !existsSync(file)) {
      fail(res, 404, "not found");
      return;
    }
    const real = realpathSync(file);
    const realRoot = realpathSync(root);
    if (!real.startsWith(`${realRoot}${sep}`) || !statSync(real).isFile()) {
      fail(res, 404, "not found");
      return;
    }
    const headers = dashboardAssetHeaders(segments.join("/") || "index.html");
    res.writeHead(200, {
      "content-type": headers["content-type"] ?? "application/octet-stream",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
      "content-security-policy": ENGINE_HTTP.prototype.csp,
    });
    res.end(readFileSync(real));
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
