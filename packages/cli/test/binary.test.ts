/**
 * The single-file binary (§4.4; spine AD-2, AD-12, AD-20 and the §7 row "Storage contract on
 * bun:sqlite, the AssetBundle from Bun-embedded files, the MCP stdio bridge"): built with
 * `bun build --compile` by `scripts/build-binary.ts`, then exercised as a user would. Skipped,
 * with the reason in the suite name, only when Bun is not installed.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASSET_SOURCES,
  CONTRACTS_VERSION,
  ENGINE_MCP_TOOLS,
  engineDiscoveryFile,
} from "@vtc/shared";
import { DEFAULT_SOURCES, renderEntry } from "../scripts/build-binary.js";
import { pidAlive } from "../src/daemon.js";
import {
  cleanupDirs,
  DASHBOARD_FIXTURE,
  commitVtcConfig,
  initRepo,
  tempDir,
  tempHome,
  writePluginTrees,
} from "./helpers.js";

const CLI_ROOT = fileURLToPath(new URL("../", import.meta.url));
const BUN = spawnSync("bun", ["--version"], { encoding: "utf8" });
const HAS_BUN = BUN.status === 0;
if (!HAS_BUN)
  console.warn("binary.test.ts: bun is not installed; the single-binary tests are skipped");

describe("the binary build script", () => {
  it("embeds exactly the AssetBundle namespaces of ASSET_SOURCES", () => {
    expect(DEFAULT_SOURCES).toEqual(ASSET_SOURCES);
  });

  it("generates one embedded-file import per asset and hands their paths to runBinary", () => {
    const entry = renderEntry({ dashboard: DASHBOARD_FIXTURE });
    expect(entry).toMatch(/^import \{ runBinary \} from ".*src\/binary\/main\.ts";/);
    expect(entry).toContain(
      `import a0 from ${JSON.stringify(join(DASHBOARD_FIXTURE, "README.md"))} with { type: "file" };`,
    );
    expect(entry).toContain(`"task/index.html": a`);
    expect(entry).toMatch(/runBinary\(\{\n {2}"dashboard": \{/);
  });
});

const bun = (...args: string[]): void => {
  const result = spawnSync("bun", args, { cwd: CLI_ROOT, encoding: "utf8", timeout: 120_000 });
  if (result.status !== 0)
    throw new Error(`bun ${args.join(" ")} failed:\n${result.stderr}${result.stdout}`);
};

const lines = (
  child: ChildProcessWithoutNullStreams,
): { next: (match: RegExp, ms?: number) => Promise<string>; all: string[] } => {
  const all: string[] = [];
  let buffer = "";
  const waiters: (() => void)[] = [];
  child.stdout.on("data", (c: Buffer) => {
    buffer += c.toString("utf8");
    const parts = buffer.split("\n");
    buffer = parts.pop() ?? "";
    all.push(...parts.filter((l) => l !== ""));
    for (const w of waiters.splice(0)) w();
  });
  const next = async (match: RegExp, ms = 20_000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = all.find((l) => match.test(l));
      if (hit !== undefined) return hit;
      if (Date.now() > deadline)
        throw new Error(`no line matching ${String(match)} in ${JSON.stringify(all)}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 100);
      });
    }
  };
  return { next, all };
};

const exited = (child: ChildProcessWithoutNullStreams): Promise<number | null> =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else
      child.once("exit", (code) => {
        resolve(code);
      });
  });

describe.skipIf(!HAS_BUN)(
  `the single binary (bun build --compile${HAS_BUN ? `, bun ${BUN.stdout.trim()}` : "; skipped: bun is not installed"})`,
  () => {
    let dir: string;
    let vtc: string;
    const children: ChildProcessWithoutNullStreams[] = [];
    const daemonPids: number[] = [];

    const run = (args: string[], cwd: string, home: string): ChildProcessWithoutNullStreams => {
      const child = spawn(vtc, args, { cwd, env: { ...process.env, VTC_HOME: home } });
      children.push(child);
      return child;
    };

    beforeAll(() => {
      dir = tempDir("vtc-bin-");
      vtc = join(dir, "vtc");
      const roots = writePluginTrees(join(dir, "plugins"));
      bun(
        "scripts/build-binary.ts",
        "--outfile",
        vtc,
        "--source",
        `dashboard=${DASHBOARD_FIXTURE}`,
        "--source",
        `plugin:claude-code=${roots["plugin:claude-code"]}`,
        "--source",
        `plugin:codex=${roots["plugin:codex"]}`,
      );
      bun(
        "scripts/build-binary.ts",
        "--storage-contract",
        "--outfile",
        join(dir, "storage-contract"),
      );
    }, 180_000);

    afterAll(() => {
      for (const c of children) if (c.exitCode === null) c.kill("SIGKILL");
      for (const pid of daemonPids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // gone
        }
      }
      cleanupDirs();
    });

    it("passes the Storage contract suite on bun:sqlite inside a compiled binary (AD-2)", () => {
      const result = spawnSync(join(dir, "storage-contract"), [], {
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(result.stdout).toContain("# runtime bun");
      expect(result.stdout).toMatch(/^1\.\.5$/m);
      expect(result.stdout).not.toContain("not ok");
      expect(result.status).toBe(0);
    });

    it("reports its version and runtime", () => {
      const result = spawnSync(vtc, ["--version"], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`contracts ${CONTRACTS_VERSION}`);
      expect(result.stdout).toMatch(/binary on bun \d+\.\d+\.\d+\)\n$/);
    });

    it("serves the embedded dashboard export as a read-only snapshot (AD-20)", async () => {
      const repo = initRepo();
      const child = run(["dashboard", "--no-open"], repo, tempHome());
      const out = lines(child);
      const line = await out.next(/^Flow Studio: /);
      const url = /http:\/\/127\.0\.0\.1:\d+\//.exec(line)?.[0] ?? "";
      expect(line).toMatch(/#nonce=[A-Za-z0-9_-]{43}$/);
      expect(await (await fetch(url)).text()).toBe(
        readFileSync(join(DASHBOARD_FIXTURE, "index.html"), "utf8"),
      );
      expect(await (await fetch(`${url}task/?run=r1&task=T-1`)).text()).toBe(
        readFileSync(join(DASHBOARD_FIXTURE, "task/index.html"), "utf8"),
      );
      const script = await fetch(`${url}_next/static/chunks/app-3f9a.js`);
      expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
      expect(script.headers.get("cache-control")).toContain("immutable");
      expect((await fetch(`${url}_next/static/chunks/missing.js`)).status).toBe(404);
      child.kill("SIGINT");
      expect(await exited(child)).toBe(0);
    }, 30_000);

    it("bridges MCP over stdio to one daemon that it starts detached once the repo is set up (AD-12)", async () => {
      const repo = initRepo();
      const home = tempHome();
      const send = (child: ChildProcessWithoutNullStreams, message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      const initialize = (child: ChildProcessWithoutNullStreams, id: number): void => {
        send(child, {
          jsonrpc: "2.0",
          id,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "test", version: "1" },
          },
        });
        send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
      };
      const a = run(["engine", "--mcp", "--host", "claude-code"], repo, home);
      const aOut = lines(a);
      initialize(a, 1);
      expect(JSON.parse(await aOut.next(/"id":1\b/))).toMatchObject({
        result: { serverInfo: { name: "vtc" } },
      });
      send(a, { jsonrpc: "2.0", id: 2, method: "tools/list" });
      const tools = JSON.parse(await aOut.next(/"id":2\b/)) as {
        result: { tools: { name: string }[] };
      };
      expect(tools.result.tools.map((t) => t.name).sort()).toEqual(
        ENGINE_MCP_TOOLS.map((t) => t.name).sort(),
      );
      // a repo vtc init never set up: the bridge answers, starts no daemon, writes nothing there
      send(a, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      });
      expect(JSON.parse(await aOut.next(/"id":3\b/))).toMatchObject({
        result: { isError: true, content: [{ text: expect.stringMatching(/vtc init/) as string }] },
      });
      expect(existsSync(join(repo, ".vtc"))).toBe(false);
      expect(existsSync(join(home, engineDiscoveryFile(repo)))).toBe(false);
      const status0 = spawnSync(vtc, ["status"], {
        cwd: repo,
        env: { ...process.env, VTC_HOME: home },
        encoding: "utf8",
      });
      expect(status0.status).toBe(1);
      expect(status0.stderr).toMatch(/run `vtc init` there first/);
      expect(
        spawnSync(vtc, ["init"], { cwd: repo, env: { ...process.env, VTC_HOME: home } }).status,
      ).toBe(0);
      // a run starts only on a committed gates.yml (D-au)
      commitVtcConfig(repo);
      // set up now: the next call starts the daemon detached
      send(a, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      });
      expect(JSON.parse(await aOut.next(/"id":4\b/))).toMatchObject({
        result: { isError: true, content: [{ text: expect.stringMatching(/no_run/) as string }] },
      });
      const discovery = JSON.parse(readFileSync(join(home, engineDiscoveryFile(repo)), "utf8")) as {
        pid: number;
        contracts_version: string;
      };
      daemonPids.push(discovery.pid);
      expect(discovery.pid).not.toBe(a.pid);
      expect(discovery.contracts_version).toBe(CONTRACTS_VERSION);
      // a second host session shares the same daemon
      const b = run(["engine", "--mcp", "--host", "codex"], repo, home);
      const bOut = lines(b);
      initialize(b, 7);
      await bOut.next(/"id":7/);
      send(b, {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "start",
          arguments: {
            request: "Add a health endpoint",
            track: "quick_fix",
            repo: "existing",
            has_ui: false,
          },
        },
      });
      const started = JSON.parse(await bOut.next(/"id":8/)) as {
        result: { structuredContent: { run: string } };
      };
      send(a, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      });
      const status = JSON.parse(await aOut.next(/"id":5\b/)) as {
        result: { structuredContent: { run: { id: string } } };
      };
      expect(status.result.structuredContent.run.id).toBe(started.result.structuredContent.run);
      expect(JSON.parse(readFileSync(join(home, engineDiscoveryFile(repo)), "utf8"))).toMatchObject(
        { pid: discovery.pid },
      );
      // the control commands reach the same daemon over its socket
      const statusCmd = spawnSync(vtc, ["status"], {
        cwd: repo,
        env: { ...process.env, VTC_HOME: home },
        encoding: "utf8",
      });
      expect(statusCmd.stdout).toContain(`Run ${started.result.structuredContent.run}: quick_fix`);
      a.stdin.end();
      b.stdin.end();
      expect(await exited(a)).toBe(0);
      expect(await exited(b)).toBe(0);
      // the daemon outlives its bridges and exits cleanly on SIGTERM, removing discovery
      process.kill(discovery.pid, "SIGTERM");
      const deadline = Date.now() + 10_000;
      while (existsSync(join(home, engineDiscoveryFile(repo))) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 100));
      expect(existsSync(join(home, engineDiscoveryFile(repo)))).toBe(false);
      while (pidAlive(discovery.pid) && Date.now() < deadline + 5_000)
        await new Promise((r) => setTimeout(r, 100));
      expect(pidAlive(discovery.pid)).toBe(false);
    }, 60_000);

    it("bridges MCP outside a git repository without a daemon or .vtc/ (D-aq, reading 74)", async () => {
      const dir = tempDir("vtc-nogit-");
      const home = tempHome();
      const child = run(["engine", "--mcp", "--host", "claude-code"], dir, home);
      const out = lines(child);
      const send = (message: unknown): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      };
      send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        },
      });
      expect(JSON.parse(await out.next(/"id":1\b/))).toMatchObject({
        result: { serverInfo: { name: "vtc" } },
      });
      send({ jsonrpc: "2.0", id: 2, method: "ping" });
      expect(JSON.parse(await out.next(/"id":2\b/))).toMatchObject({ result: {} });
      send({ jsonrpc: "2.0", id: 3, method: "tools/list" });
      expect(
        (JSON.parse(await out.next(/"id":3\b/)) as { result: { tools: unknown[] } }).result.tools,
      ).toHaveLength(ENGINE_MCP_TOOLS.length);
      send({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "status", arguments: {} },
      });
      expect(JSON.parse(await out.next(/"id":4\b/))).toMatchObject({
        result: {
          isError: true,
          content: [
            {
              text: expect.stringContaining(
                "not in a git repository: run git init, then vtc init",
              ) as string,
            },
          ],
        },
      });
      child.stdin.end();
      expect(await exited(child)).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
      expect(readdirSync(home)).toEqual([]);
    }, 30_000);

    it("runs plugin hooks fast and fails open without an engine", () => {
      const repo = initRepo();
      const started = Date.now();
      const result = spawnSync(vtc, ["hook", "pre-tool-use", "--host", "claude-code"], {
        cwd: repo,
        env: { ...process.env, VTC_HOME: tempHome() },
        input: JSON.stringify({
          cwd: repo,
          agent_type: "vtc:vtc-engineer",
          tool_name: "Bash",
          tool_input: { command: "git push" },
        }),
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(Date.now() - started).toBeLessThan(5_000);
    });
  },
);
