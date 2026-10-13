// @vitest-environment node
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { engineDiscoveryFile } from "@vtc/shared";
import {
  createEngineProxy,
  engineRequestHeaders,
  isProxiedRoute,
  readDevInstallToken,
  readEngineDiscovery,
  resolveVtcHome,
} from "../../scripts/engine-proxy-lib.ts";

const TOKEN = "t".repeat(43);
const REPO = "/work/target-repo";

const listen = (server: Server): Promise<number> =>
  new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      done((server.address() as AddressInfo).port);
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((done) => {
    server.closeAllConnections();
    server.close(() => {
      done();
    });
  });

let home: string;
let engine: Server;
let enginePort: number;
let proxy: Server;
let proxyPort: number;
let seen: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[];

const writeDiscovery = (port: number): void => {
  const file = join(home, engineDiscoveryFile(REPO));
  mkdirSync(join(home, "engines"), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({
      v: 1,
      pid: 4242,
      port,
      prototype_port: null,
      mcp_socket: join(home, "run", "x.sock"),
      repo_root: REPO,
      started_at: "2026-10-13T09:00:00.000Z",
      engine_version: "0.0.0",
      contracts_version: "4.0.0",
    }),
    { mode: 0o600 },
  );
};

const writeToken = (mode = 0o600): void => {
  const file = join(home, "token");
  writeFileSync(file, `${TOKEN}\n`, { mode });
  chmodSync(file, mode);
};

const call = (path: string, init: RequestInit = {}): Promise<Response> =>
  fetch(`http://127.0.0.1:${String(proxyPort)}${path}`, init);

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "vtc-proxy-"));
  seen = [];
  engine = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      if (req.url === "/api/stream") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("id: r1:1\ndata: {}\n\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  enginePort = await listen(engine);
  proxy = createEngineProxy({ vtcHome: home, repoRoot: REPO });
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  await close(proxy);
  await close(engine);
  rmSync(home, { recursive: true, force: true });
});

describe("dev engine proxy (AD-5 rule 8)", () => {
  it("forwards a read route with the install token, the engine's Host, and no Origin or cookie", async () => {
    writeDiscovery(enginePort);
    writeToken();
    const res = await call("/api/runs/r1/tasks/T-2?x=1", {
      headers: {
        origin: "http://127.0.0.1:4300",
        cookie: "a=b",
        authorization: "Bearer from-the-browser",
        accept: "application/json",
      },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const req = seen[0];
    expect(req?.url).toBe("/api/runs/r1/tasks/T-2?x=1");
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.headers.host).toBe(`127.0.0.1:${String(enginePort)}`);
    expect(req?.headers.origin).toBeUndefined();
    expect(req?.headers.cookie).toBeUndefined();
    expect(req?.headers.accept).toBe("application/json");
  });

  it("forwards the design-review write with its body, and streams SSE", async () => {
    writeDiscovery(enginePort);
    writeToken();
    const post = await call("/api/design/reviews", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"screen":"a"}',
    });
    expect(post.status).toBe(200);
    expect(seen[0]).toMatchObject({ method: "POST", body: '{"screen":"a"}' });
    const stream = await call("/api/stream");
    expect(stream.headers.get("content-type")).toBe("text/event-stream");
    expect(await stream.text()).toBe("id: r1:1\ndata: {}\n\n");
  });

  it("refuses install-only and nonce routes and anything outside /api", async () => {
    writeDiscovery(enginePort);
    writeToken();
    for (const [method, path] of [
      ["POST", "/api/session/nonce"],
      ["POST", "/api/session"],
      ["POST", "/api/ingest/claude-statusline"],
      ["GET", "/"],
      ["DELETE", "/api/runs"],
    ] as const) {
      const res = await call(path, { method });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    expect(seen).toHaveLength(0);
  });

  it("answers 502 without a running engine, and never puts the token in an error", async () => {
    writeToken();
    const res = await call("/api/health");
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(TOKEN);
    writeDiscovery(enginePort);
    await close(engine);
    const down = await call("/api/health");
    expect(down.status).toBe(502);
  });

  it("refuses a token file that other users can read", async () => {
    writeDiscovery(enginePort);
    writeToken(0o644);
    const res = await call("/api/health");
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).toContain("readable by other users");
    expect(text).not.toContain(TOKEN);
    expect(seen).toHaveLength(0);
  });
});

describe("dev engine proxy helpers", () => {
  it("resolves the VTC home like the cli", () => {
    expect(resolveVtcHome({ VTC_HOME: "/tmp/v" })).toBe("/tmp/v");
    expect(resolveVtcHome({})).toMatch(/\.vtc$/);
  });

  it("reads only a valid discovery file and a well-formed token", () => {
    expect(readEngineDiscovery(home, REPO)).toBeNull();
    mkdirSync(join(home, "engines"), { recursive: true });
    writeFileSync(join(home, engineDiscoveryFile(REPO)), '{"v":2}');
    expect(readEngineDiscovery(home, REPO)).toBeNull();
    writeDiscovery(1234);
    expect(readEngineDiscovery(home, REPO)?.port).toBe(1234);
    writeFileSync(join(home, "token"), "short\n", { mode: 0o600 });
    expect(() => readDevInstallToken(home)).toThrow(/does not hold a vtc install token/);
  });

  it("proxies exactly the token routes", () => {
    expect(isProxiedRoute("GET", "/api/runs/golden-1/graph")).toBe(true);
    expect(isProxiedRoute("GET", "/api/runs/golden-1/tasks/T-1/diff")).toBe(true);
    expect(isProxiedRoute("POST", "/api/design/reviews")).toBe(true);
    expect(isProxiedRoute("GET", "/api/runs/a/b/c")).toBe(false);
    expect(isProxiedRoute("POST", "/api/session")).toBe(false);
  });

  it("replaces the browser's credentials and hop-by-hop headers", () => {
    expect(
      engineRequestHeaders(
        { host: "x", connection: "keep-alive", "last-event-id": "r1:4", referer: "http://x/" },
        9,
        TOKEN,
      ),
    ).toEqual({
      "last-event-id": "r1:4",
      host: "127.0.0.1:9",
      authorization: `Bearer ${TOKEN}`,
    });
  });
});
