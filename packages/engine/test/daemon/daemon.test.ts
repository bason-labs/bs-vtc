/**
 * The composition seam (AD-19) and the instance model (AD-12): `runDaemon` takes the lock, serves
 * MCP on the socket and HTTP on 127.0.0.1, publishes discovery and cleans up; a second daemon
 * fails on the lock; `serveSnapshot` serves the committed `.vtc/` read-only without a lock.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACTS_VERSION,
  ENGINE_INSTANCE,
  engineDiscoveryFile,
  ROLE_CONTRACTS_ASSET,
  type AssetBundle,
  type EngineDeps,
  type GateRunner,
  type HostAdapter,
  type UsageReport,
} from "@vtc/shared";
import { EngineLockedError, readEngineDiscovery } from "../../src/core/index.js";
import { runDaemon, serveSnapshot } from "../../src/daemon/index.js";
import { loadNodeSqliteStorage } from "../../src/index.js";
import { connectEngineClient } from "../../src/mcp/index.js";
import { openNodeSqlite } from "../../src/storage/node-sqlite.js";
import { cleanupDirs, initRepo, tempDir } from "../helpers/repo.js";
import { DEFAULT_GATES_YML, fakeGates } from "../helpers/engine-harness.js";

/** A repo `vtc calibrate` set up: a run starts only on a committed gates.yml (reading 78). */
const calibratedRepo = (): string =>
  initRepo({ "README.md": "# app\n", ".vtc/gates.yml": `${JSON.stringify(DEFAULT_GATES_YML)}\n` });
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

const TOKEN = "t".repeat(43);
const emptyAssets: AssetBundle = { read: () => undefined, list: () => [] };
/** A bundle that carries only the compiled role contracts (the daemon refuses to start without). */
const roleAssets: AssetBundle = {
  read: (namespace, path) =>
    namespace === "plugin:claude-code" && path === ROLE_CONTRACTS_ASSET
      ? new TextEncoder().encode(JSON.stringify(ALL_FIXTURE_ROLES))
      : undefined,
  list: (namespace) => (namespace === "plugin:claude-code" ? [ROLE_CONTRACTS_ASSET] : []),
};

const depsFor = (repoRoot: string, vtcHome: string, gateRunner?: GateRunner): EngineDeps => ({
  repoRoot,
  vtcHome,
  installToken: TOKEN,
  openStorage: openNodeSqlite,
  gateRunner: gateRunner ?? fakeGates(repoRoot, () => new Date()),
  adapters: {},
  assets: roleAssets,
  scheduler: { schedule: () => Promise.resolve(), cancel: () => Promise.resolve() },
  versions: { engine: "vtc-engine@0.0.0", contracts: CONTRACTS_VERSION },
});

const shortHome = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vh-"));
  return dir;
};

const get = (port: number, path: string): Promise<{ status: number; body: string }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        headers: { host: `127.0.0.1:${String(port)}`, authorization: `Bearer ${TOKEN}` },
      },
      (res) => {
        let body = "";
        res.on("data", (c: Buffer) => (body += c.toString("utf8")));
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

describe("runDaemon (AD-12, AD-19)", () => {
  it("serves HTTP and MCP, publishes discovery, refuses a second daemon, and cleans up on close", async () => {
    const repo = calibratedRepo();
    const home = shortHome();
    const daemon = await runDaemon(depsFor(repo, home), { wake: false });
    try {
      expect(daemon.discovery).toMatchObject({
        v: 1,
        pid: process.pid,
        port: daemon.port,
        repo_root: repo,
        prototype_port: daemon.prototypePort,
      });
      expect(readEngineDiscovery(home, repo)).toEqual(daemon.discovery);
      expect(existsSync(join(repo, ENGINE_INSTANCE.lockFile))).toBe(true);
      await expect(runDaemon(depsFor(repo, home), { wake: false })).rejects.toThrow(
        EngineLockedError,
      );
      expect(JSON.parse((await get(daemon.port, "/api/health")).body)).toMatchObject({
        ok: true,
        mode: "live",
      });
      const client = await connectEngineClient(daemon.discovery.mcp_socket);
      const started = await client.call("start", {
        request: "Password reset",
        track: "feature",
        repo: "existing",
        has_ui: false,
      });
      const status = await client.call("status", {});
      expect(status.run.id).toBe(started.run);
      expect(JSON.parse((await get(daemon.port, "/api/runs")).body)).toMatchObject({
        runs: [{ id: started.run }],
      });
      await client.close();
      const index = openNodeSqlite({ path: join(repo, ".vtc/state/index.sqlite"), readonly: true });
      expect(
        Number(index.prepare("SELECT COUNT(*) AS n FROM events WHERE run = ?").get(started.run)?.n),
      ).toBeGreaterThanOrEqual(2);
      index.close();
    } finally {
      await daemon.close();
    }
    await daemon.closed;
    expect(existsSync(join(home, engineDiscoveryFile(repo)))).toBe(false);
    expect(existsSync(join(repo, ENGINE_INSTANCE.lockFile))).toBe(false);
    expect(existsSync(daemon.discovery.mcp_socket)).toBe(false);
    // a restart replays the log and continues it
    const again = await runDaemon(depsFor(repo, home), { wake: true });
    const client = await connectEngineClient(again.discovery.mcp_socket);
    expect((await client.call("status", {})).run.phase).toBe("discover");
    await client.close();
    await again.close();
  });
  it("carries an API-key login's billing in GET /api/usage from the start (D-bq, reading 171)", async () => {
    const repo = calibratedRepo();
    const home = shortHome();
    const codex = {
      capabilities: { subagents: false, headless: true, budgetCap: false },
      authStatus: () =>
        Promise.resolve({
          host: "codex" as const,
          logged_in: true,
          method: "API key",
          billing: "api_key" as const,
          checked_at: new Date().toISOString(),
        }),
    } as unknown as HostAdapter;
    const daemon = await runDaemon(
      { ...depsFor(repo, home), adapters: { codex } },
      { wake: false },
    );
    try {
      const usage = async (): Promise<UsageReport> =>
        JSON.parse((await get(daemon.port, "/api/usage")).body) as UsageReport;
      await vi.waitFor(async () => {
        expect((await usage()).hosts.find((s) => s.host === "codex")?.billing).toBe("api_key");
      });
      expect((await usage()).hosts.find((s) => s.host === "claude-code")?.billing).toBeUndefined();
    } finally {
      await daemon.close();
    }
  });

  it("serves the prototype origin once the Designer writes it mid-run (AD-5 rule 9)", async () => {
    const repo = calibratedRepo();
    const home = shortHome();
    const daemon = await runDaemon(depsFor(repo, home), { wake: false });
    try {
      // the listener runs from the start, so discovery and the health route can name it
      const port = daemon.prototypePort;
      expect(port).toEqual(expect.any(Number));
      expect(daemon.discovery.prototype_port).toBe(port);
      const health = async () =>
        (JSON.parse((await get(daemon.port, "/api/health")).body) as { prototype_url: unknown })
          .prototype_url;
      // no prototype yet: no URL, and the origin answers 404
      expect(await health()).toBeNull();
      expect((await get(port ?? 0, "/")).status).toBe(404);
      // the Designer creates .vtc/design/prototype/ after the daemon started
      mkdirSync(join(repo, ".vtc/design/prototype"), { recursive: true });
      writeFileSync(join(repo, ".vtc/design/prototype/index.html"), "<h1>proto</h1>");
      expect(await health()).toBe(`http://127.0.0.1:${String(port)}/`);
      expect(await get(port ?? 0, "/")).toMatchObject({ status: 200, body: "<h1>proto</h1>" });
    } finally {
      await daemon.close();
    }
  });
  it("takes over a stale lock and records the incident in the active run", async () => {
    const repo = calibratedRepo();
    const home = shortHome();
    const first = await runDaemon(depsFor(repo, home), { wake: false });
    const client = await connectEngineClient(first.discovery.mcp_socket);
    const { run } = await client.call("start", {
      request: "Idea",
      track: "feature",
      repo: "existing",
      has_ui: false,
    });
    await client.close();
    await first.close();
    mkdirSync(join(repo, ".vtc/state"), { recursive: true });
    writeFileSync(join(repo, ENGINE_INSTANCE.lockFile), JSON.stringify({ pid: 999_997 }));
    const second = await runDaemon(depsFor(repo, home), { wake: false });
    await second.close();
    const log = readFileSync(join(repo, `.vtc/runs/${run}/events.jsonl`), "utf8");
    expect(log).toContain('"kind":"stale_lock"');
  });
  it("takes over a lock whose pid lives but whose socket is silent (pid reuse, AD-12 rule 1)", async () => {
    const repo = calibratedRepo();
    const home = shortHome();
    const first = await runDaemon(depsFor(repo, home), { wake: false });
    const lockFile = JSON.parse(readFileSync(join(repo, ENGINE_INSTANCE.lockFile), "utf8")) as {
      socket?: string;
    };
    expect(lockFile.socket).toBe(first.discovery.mcp_socket);
    const client = await connectEngineClient(first.discovery.mcp_socket);
    const { run } = await client.call("start", {
      request: "Idea",
      track: "feature",
      repo: "existing",
      has_ui: false,
    });
    await client.close();
    await first.close();
    // this test process's pid is alive, but nothing answers on the recorded socket any more
    writeFileSync(
      join(repo, ENGINE_INSTANCE.lockFile),
      JSON.stringify({
        pid: process.pid,
        acquired_at: "2026-01-01T00:00:00.000Z",
        socket: first.discovery.mcp_socket,
      }),
    );
    const second = await runDaemon(depsFor(repo, home), { wake: false });
    await second.close();
    const log = readFileSync(join(repo, `.vtc/runs/${run}/events.jsonl`), "utf8");
    expect(log).toContain('"kind":"stale_lock"');
    expect(log).toContain("did not answer");
  });
  it("refuses to start without the compiled role contracts (AD-14 rule 6), and frees the lock", async () => {
    const repo = calibratedRepo();
    const home = shortHome();
    await expect(
      runDaemon({ ...depsFor(repo, home), assets: emptyAssets }, { wake: false }),
    ).rejects.toThrow(/role contracts .* no plugin in the asset bundle/);
    expect(existsSync(join(repo, ENGINE_INSTANCE.lockFile))).toBe(false);
  });
  it("loads the storage driver through the engine entry", async () => {
    expect(await loadNodeSqliteStorage()).toBe(openNodeSqlite);
  });
});

describe("serveSnapshot (AD-5 rule 7)", () => {
  it("serves the committed .vtc/ read-only: no lock, no discovery, ingest refused", async () => {
    const repo = tempDir("vtc-snap-");
    mkdirSync(join(repo, ".vtc/runs/golden-1"), { recursive: true });
    writeFileSync(
      join(repo, ".vtc/runs/golden-1/events.jsonl"),
      readFileSync(new URL("../../../../fixtures/golden-run/events.jsonl", import.meta.url)),
    );
    const home = shortHome();
    const snapshot = await serveSnapshot({
      repoRoot: repo,
      vtcHome: home,
      installToken: TOKEN,
      assets: emptyAssets,
      versions: { engine: "0.0.0", contracts: CONTRACTS_VERSION },
    });
    try {
      expect(JSON.parse((await get(snapshot.port, "/api/health")).body)).toMatchObject({
        mode: "snapshot",
      });
      expect(JSON.parse((await get(snapshot.port, "/api/status")).body)).toMatchObject({
        run: { id: "golden-1", phase: "build" },
      });
      expect(snapshot.mintNonce().nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(existsSync(join(repo, ENGINE_INSTANCE.lockFile))).toBe(false);
      expect(existsSync(join(home, engineDiscoveryFile(repo)))).toBe(false);
      const refused = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: snapshot.port,
            path: "/api/ingest/claude-statusline",
            method: "POST",
            headers: {
              host: `127.0.0.1:${String(snapshot.port)}`,
              authorization: `Bearer ${TOKEN}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(
          JSON.stringify({
            v: 1,
            session_id: null,
            model: null,
            rate_limits: { five_hour: null, seven_day: null },
          }),
        );
      });
      expect(refused).toBe(409);
    } finally {
      await snapshot.close();
    }
  });
  it("redacts the repo's .env values in design-review pins it appends (AD-18 rule 1)", async () => {
    const repo = tempDir("vtc-snap-");
    writeFileSync(join(repo, ".env"), "DB_PASSWORD=correct-horse-battery\n");
    const snapshot = await serveSnapshot({
      repoRoot: repo,
      vtcHome: shortHome(),
      installToken: TOKEN,
      assets: emptyAssets,
      versions: { engine: "0.0.0", contracts: CONTRACTS_VERSION },
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port: snapshot.port,
            path: "/api/design/reviews",
            method: "POST",
            headers: {
              host: `127.0.0.1:${String(snapshot.port)}`,
              authorization: `Bearer ${TOKEN}`,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(
          JSON.stringify({
            screen: "login",
            state: "empty",
            viewport: 1280,
            theme: "light",
            x_pct: 1,
            y_pct: 2,
            comment: "the password correct-horse-battery shows",
          }),
        );
      });
      expect(status).toBe(200);
      const pins = readFileSync(join(repo, ".vtc/design/reviews/login.jsonl"), "utf8");
      expect(pins).not.toContain("correct-horse-battery");
      expect(pins).toContain("[REDACTED:known_value]");
    } finally {
      await snapshot.close();
    }
  });
});
