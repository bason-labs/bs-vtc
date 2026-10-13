/**
 * Composition (AD-19) and the instance model from the cli's side (AD-12): the parts the cli
 * builds, the daemon they start (serving the embedded-or-disk dashboard and the compiled role
 * contracts), discovery, the stdio bridge, and the control client.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { mcp } from "@vtc/engine";
import {
  CONTRACTS_VERSION,
  engineDiscoveryFile,
  type GateRunner,
  type HostAdapter,
  type RunningDaemon,
} from "@vtc/shared";
import { createDiskAssetBundle } from "../src/assets.js";
import { daemonAnswers, ensureDaemon, liveDaemon, pidAlive } from "../src/daemon.js";
import {
  buildEngineParts,
  composeEngineDeps,
  connectToRepoEngine,
  createAdapters,
  lazyGateRunner,
  startDaemon,
  type EngineParts,
} from "../src/wiring.js";
import {
  cleanupDirs,
  DASHBOARD_FIXTURE,
  fakeGateRunner,
  fakePullRequests,
  initRepo,
  tempDir,
  tempHome,
  writePluginTrees,
} from "./helpers.js";

const TOKEN = "k".repeat(43);
const daemons: RunningDaemon[] = [];

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.close();
  cleanupDirs();
});

const partsFor = async (repoRoot: string, vtcHome: string): Promise<EngineParts> =>
  buildEngineParts({
    repoRoot,
    vtcHome,
    installToken: TOKEN,
    assets: createDiskAssetBundle(writePluginTrees(tempDir())),
    createGateRunner: fakeGateRunner,
    pullRequests: fakePullRequests(),
    adapterFactories: {},
  });

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

describe("buildEngineParts and composeEngineDeps (AD-19)", () => {
  it("injects the PR service, adapters, timer and versions the daemon needs", async () => {
    const prs = fakePullRequests();
    const adapter = { host: "codex", dispose: () => Promise.resolve() } as unknown as HostAdapter;
    const parts = await buildEngineParts({
      repoRoot: "/r",
      vtcHome: "/h",
      installToken: TOKEN,
      assets: createDiskAssetBundle({}),
      pullRequests: prs,
      adapterFactories: { codex: () => adapter },
    });
    const deps = composeEngineDeps(parts);
    expect(deps.pullRequests).toBe(prs);
    expect(deps.adapters).toEqual({ codex: adapter });
    expect(deps.versions).toEqual({ engine: "vtc-engine@0.0.0", contracts: CONTRACTS_VERSION });
    expect(deps.openStorage({ path: ":memory:" }).driver).toBe("node:sqlite");
    expect(typeof deps.scheduler.schedule).toBe("function");
  });

  it("defaults to the gh-backed PR service, which runs gh only when called", async () => {
    const bin = tempDir();
    const log = join(bin, "calls.txt");
    const gh = join(bin, "gh");
    writeFileSync(
      gh,
      `#!/bin/sh\necho "$@" >> "${log}"\necho '{"url":"https://github.com/o/r/pull/7","isDraft":true,"state":"OPEN","headRefOid":"${"a".repeat(40)}","statusCheckRollup":[]}'\n`,
    );
    chmodSync(gh, 0o755);
    const repo = initRepo();
    const parts = await buildEngineParts({
      repoRoot: repo,
      vtcHome: tempHome(),
      installToken: TOKEN,
      assets: createDiskAssetBundle({}),
      ghCommand: gh,
      adapterFactories: {},
    });
    expect(existsSync(log)).toBe(false);
    const pr = await composeEngineDeps(parts).pullRequests?.view("vtc/F-1");
    expect(pr).toMatchObject({ url: "https://github.com/o/r/pull/7", draft: true, state: "open" });
    expect(readFileSync(log, "utf8")).toMatch(/^pr view vtc\/F-1 --json /);
  });

  it("builds the Gate Runner on first use, once, and passes a broken one's error to the caller", async () => {
    let created = 0;
    const runner = lazyGateRunner((): GateRunner => {
      created += 1;
      throw new Error("createGateRunner is not implemented yet");
    });
    expect(created).toBe(0);
    await expect(runner.checkWriteScope({} as never)).rejects.toThrow(/not implemented/);
    expect(created).toBe(1);
  });

  it("constructs one adapter per registered factory (AD-6 rule 6)", () => {
    const a = { host: "claude-code" } as HostAdapter;
    expect(createAdapters({ "claude-code": () => a })).toEqual({ "claude-code": a });
    expect(createAdapters({})).toEqual({});
  });
});

describe("the daemon the cli wires (AD-12, AD-20)", () => {
  it("starts on the compiled role contracts, serves the dashboard and is found by discovery", async () => {
    const repo = initRepo();
    const home = tempHome();
    const daemon = await startDaemon(await partsFor(repo, home), { wake: false });
    daemons.push(daemon);
    expect(await liveDaemon(home, repo)).toEqual(daemon.discovery);
    const index = await get(daemon.port, "/");
    expect(index.status).toBe(200);
    expect(index.body).toBe(readFileSync(join(DASHBOARD_FIXTURE, "index.html"), "utf8"));
    expect((await get(daemon.port, "/task/?run=r1&task=T-1")).body).toBe(
      readFileSync(join(DASHBOARD_FIXTURE, "task/index.html"), "utf8"),
    );
    expect((await get(daemon.port, "/_next/static/chunks/nope.js")).status).toBe(404);
    // ensureDaemon finds the live one and starts nothing
    expect(
      await ensureDaemon({ vtcHome: home, repoRoot: repo, selfCommand: ["/nonexistent/vtc"] }),
    ).toEqual(daemon.discovery);
    // the control commands' client (AD-19 rule 4)
    const client = await connectToRepoEngine(join(repo), home);
    await expect(client.call("status", {})).rejects.toThrow(/no_run/);
    const started = await client.call("start", {
      request: "Add a health endpoint",
      track: "quick_fix",
      repo: "existing",
      has_ui: false,
    });
    expect((await client.call("status", {})).run.id).toBe(started.run);
    await client.close();
  });

  it("relays MCP for two bridges sharing one daemon (AD-12 rule 3)", async () => {
    const repo = initRepo();
    const home = tempHome();
    const daemon = await startDaemon(await partsFor(repo, home), { wake: false });
    daemons.push(daemon);
    const bridge = (host: "claude-code" | "codex") => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const lines: string[] = [];
      let buffer = "";
      stdout.on("data", (c: Buffer) => {
        buffer += c.toString("utf8");
        const parts = buffer.split("\n");
        buffer = parts.pop() ?? "";
        lines.push(...parts.filter((l) => l !== ""));
      });
      const done = mcp.runStdioBridge({ path: daemon.discovery.mcp_socket, host, stdin, stdout });
      return { stdin, lines, done };
    };
    const a = bridge("claude-code");
    const b = bridge("codex");
    const init = (id: number): string =>
      `${JSON.stringify({ jsonrpc: "2.0", id, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`;
    a.stdin.write(init(1));
    b.stdin.write(init(2));
    const deadline = Date.now() + 5_000;
    while ((a.lines.length === 0 || b.lines.length === 0) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 20));
    expect(JSON.parse(a.lines[0] ?? "{}")).toMatchObject({
      id: 1,
      result: { serverInfo: { name: "vtc" } },
    });
    expect(JSON.parse(b.lines[0] ?? "{}")).toMatchObject({
      id: 2,
      result: { serverInfo: { name: "vtc" } },
    });
    a.stdin.end();
    b.stdin.end();
    await Promise.all([a.done, b.done]);
  });

  it("reports a daemon that fails to start instead of waiting out the timeout", async () => {
    const repo = initRepo();
    const home = tempHome();
    const started = Date.now();
    await expect(
      ensureDaemon({
        vtcHome: home,
        repoRoot: repo,
        selfCommand: [
          process.execPath,
          "-e",
          "console.error('boom: cannot start'); process.exit(3)",
        ],
        timeoutMs: 15_000,
      }),
    ).rejects.toThrow(/did not start .*boom: cannot start/);
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  it("treats a discovery record whose process is gone as no daemon", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(2 ** 22 + 12345)).toBe(false);
  });

  it("treats a record whose pid is alive but whose socket does not answer as stale (AD-12 rule 3)", async () => {
    const repo = initRepo();
    const home = tempHome();
    // a daemon that died without cleanup, its pid since reused (here: by this test process)
    const stale = {
      v: 1,
      pid: process.pid,
      port: 1,
      prototype_port: null,
      mcp_socket: join(home, "run", "dead.sock"),
      repo_root: repo,
      started_at: "2026-10-13T00:00:00.000Z",
      engine_version: "vtc-engine@0.0.0",
      contracts_version: CONTRACTS_VERSION,
    };
    mkdirSync(join(home, "engines"), { recursive: true });
    writeFileSync(join(home, engineDiscoveryFile(repo)), JSON.stringify(stale));
    expect(await daemonAnswers(stale.mcp_socket, 500)).toBe(false);
    expect(await liveDaemon(home, repo)).toBeNull();
    // ensureDaemon starts a new daemon instead of returning the stale record
    await expect(
      ensureDaemon({
        vtcHome: home,
        repoRoot: repo,
        selfCommand: [process.execPath, "-e", "console.error('started'); process.exit(3)"],
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow(/did not start .*started/);
    // a live daemon's socket answers the hello
    const daemon = await startDaemon(await partsFor(repo, home), { wake: false });
    daemons.push(daemon);
    expect(await daemonAnswers(daemon.discovery.mcp_socket)).toBe(true);
    // something else listening on the path is not a daemon
    const accepted: Socket[] = [];
    const fake = createServer((s) => {
      accepted.push(s);
      s.on("error", () => undefined);
      s.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    });
    const fakePath = join(home, "run", "fake.sock");
    await new Promise<void>((r) => fake.listen(fakePath, r));
    try {
      expect(await daemonAnswers(fakePath, 500)).toBe(false);
    } finally {
      for (const s of accepted) s.destroy();
      await new Promise((r) => fake.close(r));
    }
  }, 20_000);
});
