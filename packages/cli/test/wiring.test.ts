/**
 * Composition (AD-19) and the instance model from the cli's side (AD-12): the parts the cli
 * builds, the daemon they start (serving the embedded-or-disk dashboard and the compiled role
 * contracts), discovery, the stdio bridge, and the control client.
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  ENGINE_INSTANCE,
  ENGINE_MCP_TOOLS,
  engineDiscoveryFile,
  ProjectConfigSchema,
  USER_CONFIG_FILE,
  type CreateGateRunner,
  type GateRunner,
  type HostAdapter,
  type RunningDaemon,
} from "@vtc/shared";
import type { AdapterFactoryOptions } from "@vtc/adapters";
import { createDiskAssetBundle } from "../src/assets.js";
import { runBridge } from "../src/bridge.js";
import {
  daemonAnswers,
  daemonEnv,
  daemonState,
  ensureDaemon,
  liveDaemon,
  pidAlive,
  spawnDetachedDaemon,
  stopDaemon,
} from "../src/daemon.js";
import { checkEngine } from "../src/doctor-checks.js";
import { isVtcProject } from "../src/repo.js";
import { passthroughOf, readUserConfig } from "../src/user-config.js";
import {
  buildEngineParts,
  composeEngineDeps,
  connectToRepoEngine,
  createAdapters,
  disposeAdapters,
  lazyGateRunner,
  resolveVtcHome,
  startDaemon,
  type EngineParts,
} from "../src/wiring.js";
import { VERSION } from "../src/version.js";
import {
  cleanupDirs,
  DASHBOARD_FIXTURE,
  fakeGateRunner,
  fakePullRequests,
  initProject,
  initRepo,
  initVtcRepo,
  lineSink,
  rpc,
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

  it("constructs one adapter per registered factory, with its plugin, home and version (AD-6 rule 6)", () => {
    const a = { host: "claude-code" } as HostAdapter;
    const c = { host: "codex" } as HostAdapter;
    const seen: [string, AdapterFactoryOptions | undefined][] = [];
    const adapters = createAdapters(
      {
        "claude-code": (o) => (seen.push(["claude-code", o]), a),
        codex: (o) => (seen.push(["codex", o]), c),
      },
      { vtcHome: "/vh", pluginDir: (host, vtcHome) => `${vtcHome}/plugins/${host}` },
    );
    expect(adapters).toEqual({ "claude-code": a, codex: c });
    // models never come from the factory: the engine resolves them (reading 66)
    expect(seen).toEqual([
      [
        "claude-code",
        { pluginDir: "/vh/plugins/claude-code", vtcHome: "/vh", vtcVersion: VERSION },
      ],
      ["codex", { pluginDir: "/vh/plugins/codex", vtcHome: "/vh", vtcVersion: VERSION }],
    ]);
    expect(createAdapters({}, { vtcHome: "/vh", pluginDir: () => "/p" })).toEqual({});
  });

  it("threads the plugin dir into the daemon's adapters and builds the Gate Runner on its git", async () => {
    const seen: (AdapterFactoryOptions | undefined)[] = [];
    const gateDeps: Parameters<CreateGateRunner>[0][] = [];
    const repo = initRepo();
    const parts = await buildEngineParts({
      repoRoot: repo,
      vtcHome: "/vh",
      installToken: TOKEN,
      assets: createDiskAssetBundle({}),
      pullRequests: fakePullRequests(),
      pluginDir: (host) => `/extracted/${host}`,
      adapterFactories: {
        "claude-code": (o) => {
          seen.push(o);
          return { host: "claude-code", dispose: () => Promise.resolve() } as never;
        },
      },
      createGateRunner: (deps) => {
        gateDeps.push(deps);
        return fakeGateRunner();
      },
    });
    expect(seen).toEqual([
      { pluginDir: "/extracted/claude-code", vtcHome: "/vh", vtcVersion: VERSION },
    ]);
    expect(gateDeps).toEqual([]); // built on first use
    await parts.gateRunner.checkWriteScope({} as never).catch(() => undefined);
    expect(gateDeps).toHaveLength(1);
    expect(gateDeps[0]).toMatchObject({ repoRoot: repo, vtcHome: "/vh" });
    expect(typeof gateDeps[0]?.git.readFileAtCommit).toBe("function");
  });

  it("disposes every adapter on shutdown, even when one fails to", async () => {
    const disposed: string[] = [];
    await disposeAdapters({
      adapters: {
        "claude-code": {
          dispose: () => (disposed.push("claude-code"), Promise.reject(new Error("x"))),
        } as never,
        codex: { dispose: () => (disposed.push("codex"), Promise.resolve()) } as never,
      },
    });
    expect(disposed.sort()).toEqual(["claude-code", "codex"]);
  });
});

describe("the daemon the cli wires (AD-12, AD-20)", () => {
  it("starts on the compiled role contracts, serves the dashboard and is found by discovery", async () => {
    const repo = initVtcRepo();
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
    const repo = initVtcRepo();
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
      // the cli's own relay; a 4.3 daemon takes the session's sandbox state in the hello
      const done = runBridge({
        repoRoot: repo,
        host,
        stdin,
        stdout,
        initialised: () => true,
        daemon: () => Promise.resolve(daemon.discovery),
        sessionSandbox: () => (host === "claude-code" ? "on" : undefined),
        serverVersion: "vtc-engine@0.0.0",
      });
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
    const repo = initVtcRepo();
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
    const repo = initVtcRepo();
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

describe("repos vtc init never set up (the plugins are user-scoped)", () => {
  it("starts no daemon for the control commands or ensureDaemon", async () => {
    const repo = initRepo();
    const home = tempHome();
    expect(isVtcProject(repo)).toBe(false);
    await expect(
      ensureDaemon({ vtcHome: home, repoRoot: repo, selfCommand: ["/nonexistent/vtc"] }),
    ).rejects.toThrow(/VTC is not set up in .*: run `vtc init` there first/);
    await expect(connectToRepoEngine(repo, home)).rejects.toThrow(/run `vtc init`/);
    expect(existsSync(join(repo, ".vtc"))).toBe(false);
    expect(existsSync(join(home, "logs"))).toBe(false);
  });

  it("the bridge answers MCP itself until vtc init, then starts the engine on the next call", async () => {
    const repo = initRepo();
    const home = tempHome();
    let started = 0;
    const stdin = new PassThrough();
    const { stdout, next } = lineSink();
    const done = runBridge({
      repoRoot: repo,
      host: "claude-code",
      stdin,
      stdout,
      initialised: () => isVtcProject(repo),
      daemon: async () => {
        started += 1;
        const daemon = await startDaemon(await partsFor(repo, home), { wake: false });
        daemons.push(daemon);
        return daemon.discovery;
      },
      serverVersion: "vtc-engine@0.0.0",
    });
    stdin.write(
      rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
    );
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect(await next(/"id":1\b/)).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "vtc" } },
    });
    stdin.write(rpc(2, "tools/list"));
    const tools = (await next(/"id":2\b/)) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual(
      ENGINE_MCP_TOOLS.map((t) => t.name).sort(),
    );
    stdin.write(rpc(3, "tools/call", { name: "status", arguments: {} }));
    const refused = (await next(/"id":3\b/)) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toMatch(/not set up in .*run `vtc init`/);
    stdin.write(rpc(9, "resources/list"));
    expect(await next(/"id":9\b/)).toMatchObject({ error: { code: -32601 } });
    expect(started).toBe(0);
    expect(existsSync(join(repo, ".vtc"))).toBe(false);
    // the user runs vtc init: the next call reaches a daemon, relayed byte for byte from then on
    initProject(repo);
    stdin.write(rpc(4, "tools/call", { name: "status", arguments: {} }));
    stdin.write(
      rpc(5, "tools/call", {
        name: "start",
        arguments: {
          request: "Add a health endpoint",
          track: "quick_fix",
          repo: "existing",
          has_ui: false,
        },
      }),
    );
    const status = (await next(/"id":4\b/)) as {
      result: { isError: boolean; content: { text: string }[] };
    };
    expect(status.result.isError).toBe(true);
    expect(status.result.content[0]?.text).toMatch(/no_run/);
    const run = (await next(/"id":5\b/)) as { result: { structuredContent: { run: string } } };
    expect(run.result.structuredContent.run).toMatch(/\S/);
    stdin.write(rpc(6, "tools/call", { name: "status", arguments: {} }));
    expect(await next(/"id":6\b/)).toMatchObject({
      result: { structuredContent: { run: { id: run.result.structuredContent.run } } },
    });
    expect(started).toBe(1);
    stdin.end();
    await done;
  }, 30_000);
});

describe("the daemon's environment, home and start-up race", () => {
  it("starts the daemon with an allow-listed environment, not the host session's", () => {
    const env = daemonEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        LC_ALL: "C.UTF-8",
        XDG_CONFIG_HOME: "/home/u/.config",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "cli",
        ANTHROPIC_API_KEY: "sk-secret",
        GITHUB_TOKEN: "ghp_secret",
        AWS_SECRET_ACCESS_KEY: "secret",
        VTC_HOME: "/elsewhere",
      },
      "/vh",
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      LC_ALL: "C.UTF-8",
      XDG_CONFIG_HOME: "/home/u/.config",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      VTC_HOME: "/vh",
    });
  });

  it("passes only the credential variables the user lists in ~/.vtc/config.yaml (D-ak)", () => {
    const home = tempHome();
    const source = {
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      GITHUB_TOKEN: "ghp_secret",
      OPENAI_API_KEY: "sk-other",
    };
    // no config file: { version: 1 }, nothing passes
    expect(readUserConfig(home)).toEqual({
      ok: true,
      path: join(home, USER_CONFIG_FILE),
      config: { version: 1, env_passthrough: [] },
    });
    expect(daemonEnv(source, home, [])).toEqual({ PATH: "/usr/bin", VTC_HOME: home });
    writeFileSync(
      join(home, USER_CONFIG_FILE),
      "version: 1\nenv_passthrough:\n  - GITHUB_TOKEN\n  - NOT_SET\n",
    );
    const read = readUserConfig(home);
    expect(read).toMatchObject({
      ok: true,
      config: { env_passthrough: ["GITHUB_TOKEN", "NOT_SET"] },
    });
    expect(daemonEnv(source, home, passthroughOf(read))).toEqual({
      PATH: "/usr/bin",
      GITHUB_TOKEN: "ghp_secret",
      VTC_HOME: home,
    });
    // a file that does not parse passes nothing and says why
    writeFileSync(join(home, USER_CONFIG_FILE), 'version: 1\nenv_passthrough: ["bad name"]\n');
    const bad = readUserConfig(home);
    expect(bad.ok).toBe(false);
    expect(passthroughOf(bad)).toEqual([]);
    expect(bad.ok ? "" : bad.error).toMatch(/env_passthrough/);
    // VTC_HOME is always the daemon's own, whatever is listed
    expect(daemonEnv({ VTC_HOME: "/elsewhere" }, home, ["VTC_HOME"])).toEqual({ VTC_HOME: home });
  });

  it("starts the detached daemon with the user's passthrough names", async () => {
    const home = tempHome();
    const repo = initVtcRepo();
    const out = join(tempDir(), "env.json");
    writeFileSync(join(home, USER_CONFIG_FILE), "version: 1\nenv_passthrough: [VTC_TEST_PASS]\n");
    process.env.VTC_TEST_PASS = "pass-me";
    process.env.VTC_TEST_DROP = "drop-me";
    try {
      const child = spawnDetachedDaemon({
        vtcHome: home,
        repoRoot: repo,
        selfCommand: [
          process.execPath,
          "-e",
          `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env))`,
        ],
      });
      await new Promise((resolve) => child.once("exit", resolve));
    } finally {
      delete process.env.VTC_TEST_PASS;
      delete process.env.VTC_TEST_DROP;
    }
    const env = JSON.parse(readFileSync(out, "utf8")) as Record<string, string>;
    expect(env.VTC_TEST_PASS).toBe("pass-me");
    expect(env.VTC_TEST_DROP).toBeUndefined();
    expect(env.VTC_HOME).toBe(home);
  });

  it("never takes env_passthrough from the repo's project.yaml", () => {
    const repo = initRepo();
    mkdirSync(join(repo, ".vtc"), { recursive: true });
    writeFileSync(
      join(repo, ".vtc/project.yaml"),
      "version: 1\nenv_passthrough:\n  - GITHUB_TOKEN\n",
    );
    // ProjectConfigSchema has no such key; the daemon reads only the user's file
    expect(ProjectConfigSchema.safeParse({ version: 1, env_passthrough: ["X"] }).success).toBe(
      false,
    );
    expect(passthroughOf(readUserConfig(tempHome()))).toEqual([]);
  });

  it("resolves a relative VTC_HOME against the caller's cwd", () => {
    expect(resolveVtcHome({ VTC_HOME: "rel/home" }, "/work")).toBe("/work/rel/home");
    expect(resolveVtcHome({ VTC_HOME: "/abs" }, "/work")).toBe("/abs");
    expect(resolveVtcHome({}, "/work")).toMatch(/\.vtc$/);
  });

  it("keeps waiting while another process holds the engine lock, past the early-exit grace", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], {
      stdio: "ignore",
    });
    const lock = join(repo, ENGINE_INSTANCE.lockFile);
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(
      lock,
      `${JSON.stringify({ pid: holder.pid, acquired_at: new Date().toISOString() })}\n`,
    );
    const began = Date.now();
    const ensured = ensureDaemon({
      vtcHome: home,
      repoRoot: repo,
      // loses the lock at once, as a second start would
      selfCommand: [process.execPath, "-e", "process.exit(1)"],
      timeoutMs: 15_000,
    });
    // built before the lock is released, so the winner publishes within the exit grace even
    // when this test runs alone (cold module loads)
    const parts = await partsFor(repo, home);
    await new Promise((r) => setTimeout(r, 3_000));
    // the holder turns out to be the winner: it publishes its discovery record
    holder.kill("SIGKILL");
    unlinkSync(lock);
    const daemon = await startDaemon(parts, { wake: false });
    daemons.push(daemon);
    expect(await ensured).toEqual(daemon.discovery);
    expect(Date.now() - began).toBeGreaterThan(2_500);
  }, 25_000);
});

describe("a running daemon that refuses this vtc (an upgrade left it running)", () => {
  it("is reported with how to stop it, by ensureDaemon and doctor, and vtc engine --stop stops it", async () => {
    const repo = initVtcRepo();
    const home = tempHome();
    const socketPath = join(home, "run", "old.sock");
    mkdirSync(join(home, "run"), { recursive: true });
    const welcome = JSON.stringify({
      v: 1,
      ok: false,
      engine_version: "vtc-engine@9.0.0",
      contracts_version: "9.0.0",
      error: "contracts 9.0.0 is not compatible with 4.0.0",
    });
    const old = spawn(
      process.execPath,
      [
        "-e",
        `const s = require("node:net").createServer((c) => { c.on("error", () => {}); c.once("data", () => c.end(${JSON.stringify(`${welcome}
`)})); });
         s.listen(process.argv[1], () => console.log("ready"));
         process.on("SIGTERM", () => { s.close(); process.exit(0); });`,
        socketPath,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise<void>((r) => {
      old.stdout.once("data", () => {
        r();
      });
    });
    mkdirSync(join(home, "engines"), { recursive: true });
    writeFileSync(
      join(home, engineDiscoveryFile(repo)),
      JSON.stringify({
        v: 1,
        pid: old.pid,
        port: 1,
        prototype_port: null,
        mcp_socket: socketPath,
        repo_root: repo,
        started_at: "2026-10-13T00:00:00.000Z",
        engine_version: "vtc-engine@9.0.0",
        contracts_version: "9.0.0",
      }),
    );
    try {
      expect(await liveDaemon(home, repo)).toBeNull();
      const found = await daemonState(home, repo);
      expect(found).toMatchObject({ state: "refused", error: /not compatible/ });
      await expect(
        ensureDaemon({ vtcHome: home, repoRoot: repo, selfCommand: ["/nonexistent/vtc"] }),
      ).rejects.toThrow(
        new RegExp(`pid ${String(old.pid)}\\) refused this vtc .*vtc engine --stop`),
      );
      expect(checkEngine(repo, found)).toMatchObject({
        name: "engine",
        status: "fail",
        detail: expect.stringMatching(/refuses this vtc .*run vtc engine --stop/) as string,
      });
      expect(checkEngine(repo, { state: "absent" })).toBeNull();
      expect(await stopDaemon(home, repo)).toBe(old.pid);
      expect(pidAlive(old.pid ?? 0)).toBe(false);
      expect(await stopDaemon(home, repo)).toBeNull();
    } finally {
      if (old.exitCode === null) old.kill("SIGKILL");
    }
  }, 20_000);
});
