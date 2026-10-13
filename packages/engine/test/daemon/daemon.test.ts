/**
 * The composition seam (AD-19) and the instance model (AD-12): `runDaemon` takes the lock, serves
 * MCP on the socket and HTTP on 127.0.0.1, publishes discovery and cleans up; a second daemon
 * fails on the lock; `serveSnapshot` serves the committed `.vtc/` read-only without a lock.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  ENGINE_INSTANCE,
  engineDiscoveryFile,
  type AssetBundle,
  type EngineDeps,
  type GateRunner,
} from "@vtc/shared";
import { EngineLockedError, readEngineDiscovery } from "../../src/core/index.js";
import { runDaemon, serveSnapshot } from "../../src/daemon/index.js";
import { loadNodeSqliteStorage } from "../../src/index.js";
import { connectEngineClient } from "../../src/mcp/index.js";
import { openNodeSqlite } from "../../src/storage/node-sqlite.js";
import { cleanupDirs, initRepo, tempDir } from "../helpers/repo.js";
import { fakeGates } from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const TOKEN = "t".repeat(43);
const emptyAssets: AssetBundle = { read: () => undefined, list: () => [] };

const depsFor = (repoRoot: string, vtcHome: string, gateRunner?: GateRunner): EngineDeps => ({
  repoRoot,
  vtcHome,
  installToken: TOKEN,
  openStorage: openNodeSqlite,
  gateRunner: gateRunner ?? fakeGates(repoRoot, () => new Date()),
  adapters: {},
  assets: emptyAssets,
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
    const repo = initRepo();
    const home = shortHome();
    const daemon = await runDaemon(depsFor(repo, home), { wake: false });
    try {
      expect(daemon.discovery).toMatchObject({
        v: 1,
        pid: process.pid,
        port: daemon.port,
        repo_root: repo,
        prototype_port: null,
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
  it("takes over a stale lock and records the incident in the active run", async () => {
    const repo = initRepo();
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
});
