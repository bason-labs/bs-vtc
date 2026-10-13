/**
 * The cli side of the hardening round (Lead decisions D-al, D-an, D-aq; spine §5 readings 69, 71
 * and 74): the bridge outside a git repository, the Claude session sandbox the bridge reports and
 * `vtc install --host claude-code` writes, the human channel for the human-only tools, the gate
 * sandbox the cli composes and `vtc doctor` reports.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeSessionSandboxSettings,
  CONTRACTS_VERSION,
  ENGINE_MCP_TOOLS,
  EngineSocketHelloSchema,
  GATE_SANDBOX,
  HUMAN_ONLY_TOOLS,
  humanChannelRequired,
  type CreateGateRunner,
  type EngineClient,
  type HostAdapter,
  type InstallRequest,
} from "@vtc/shared";
import { bridgeHello, contractsAtLeast, NOT_A_GIT_REPO, runBridge } from "../src/bridge.js";
import { createDoctorCommand } from "../src/commands/doctor.js";
import { createEngineCommand } from "../src/commands/engine.js";
import {
  createInstallCommand,
  defaultInstallDeps,
  type InstallDeps,
} from "../src/commands/install.js";
import { checkGateSandbox, detectGateSandbox } from "../src/doctor-checks.js";
import { guardHumanOnly, humanCliHello } from "../src/human-channel.js";
import type { Exec, ExecResult } from "../src/process.js";
import {
  CLAUDE_LOCAL_SETTINGS,
  claudeSessionSandboxOf,
  mergeSessionSandboxSettings,
} from "../src/session-sandbox.js";
import type { UserConfigRead } from "../src/user-config.js";
import { buildEngineParts } from "../src/wiring.js";
import { createDiskAssetBundle } from "../src/assets.js";
import {
  capture,
  cleanupDirs,
  fakeGateRunner,
  fakePullRequests,
  git,
  initRepo,
  lineSink,
  rpc,
  tempDir,
  tempHome,
} from "./helpers.js";

afterEach(cleanupDirs);

const TOKEN = "k".repeat(43);

const initialize = (id: number): string =>
  rpc(id, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "t", version: "1" },
  });

describe("vtc engine --mcp outside a git repository (D-aq, reading 74)", () => {
  it("answers initialize, ping and tools/list itself, refuses tools/call, writes nothing", async () => {
    const dir = tempDir("vtc-nogit-");
    expect(() => git(dir, "rev-parse", "--show-toplevel")).toThrow();
    const home = tempHome();
    const stdin = new PassThrough();
    const { stdout, next } = lineSink();
    const { ctx, err } = capture(dir, home, () =>
      Promise.reject(new Error("the bridge never opens an engine client")),
    );
    const done = createEngineCommand(() => ({ stdin, stdout })).run(
      ["--mcp", "--host", "claude-code"],
      ctx,
    );
    stdin.write(initialize(1));
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    expect(await next(/"id":1\b/)).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "vtc" } },
    });
    stdin.write(rpc(2, "ping"));
    expect(await next(/"id":2\b/)).toMatchObject({ result: {} });
    stdin.write(rpc(3, "tools/list"));
    const tools = (await next(/"id":3\b/)) as { result: { tools: { name: string }[] } };
    expect(tools.result.tools.map((t) => t.name).sort()).toEqual(
      ENGINE_MCP_TOOLS.map((t) => t.name).sort(),
    );
    for (const id of [4, 5]) {
      stdin.write(rpc(id, "tools/call", { name: "status", arguments: {} }));
      const refused = (await next(new RegExp(`"id":${String(id)}\\b`))) as {
        result: { isError: boolean; content: { text: string }[] };
      };
      expect(refused.result.isError).toBe(true);
      expect(JSON.parse(refused.result.content[0]?.text ?? "{}")).toEqual({
        error: "not in a git repository: run git init, then vtc init",
      });
    }
    expect(NOT_A_GIT_REPO).toBe("not in a git repository: run git init, then vtc init");
    stdin.end();
    expect(await done).toBe(0);
    expect(err).toEqual([]);
    expect(existsSync(join(dir, ".vtc"))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    expect(readdirSync(home)).toEqual([]); // no discovery, socket, log or token: no daemon
  });
});

/** A fake daemon socket: records each hello and welcomes it as `contracts`. */
const fakeDaemon = async (
  contracts: string,
): Promise<{ path: string; hellos: unknown[]; server: Server }> => {
  const path = join(tempHome(), "d.sock");
  const hellos: unknown[] = [];
  const sockets: Socket[] = [];
  const server = createServer((socket) => {
    sockets.push(socket);
    socket.on("error", () => undefined);
    let buffer = "";
    let greeted = false;
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const at = buffer.indexOf("\n");
      if (at < 0 || greeted) return;
      greeted = true;
      hellos.push(JSON.parse(buffer.slice(0, at)));
      socket.write(
        `${JSON.stringify({ v: 1, ok: true, engine_version: "vtc-engine@0.0.0", contracts_version: contracts })}\n`,
      );
    });
  });
  server.on("close", () => {
    for (const s of sockets) s.destroy();
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, hellos, server };
};

describe("the session sandbox the bridge reports (D-an, reading 71)", () => {
  it("builds the hello: session_sandbox only to a 4.3.0+ daemon, and only from a bridge", () => {
    expect(contractsAtLeast("4.3.0", "4.3.0")).toBe(true);
    expect(contractsAtLeast("4.10.0", "4.3.0")).toBe(true);
    expect(contractsAtLeast("5.0.0", "4.3.0")).toBe(true);
    expect(contractsAtLeast("4.2.9", "4.3.0")).toBe(false);
    expect(contractsAtLeast("3.9.0", "4.3.0")).toBe(false);
    const on = bridgeHello("claude-code", "4.3.0", "on");
    expect(on).toEqual({
      v: 1,
      client: "bridge",
      host: "claude-code",
      contracts_version: CONTRACTS_VERSION,
      session_sandbox: "on",
    });
    expect(EngineSocketHelloSchema.safeParse(on).success).toBe(true);
    expect(bridgeHello("claude-code", "4.2.0", "on")).not.toHaveProperty("session_sandbox");
    expect(bridgeHello("codex", "4.3.0", undefined)).not.toHaveProperty("session_sandbox");
    expect(bridgeHello("claude-code", "4.3.0", "off")).toMatchObject({ session_sandbox: "off" });
  });

  it("sends the state in the relay's hello, and leaves it out for an older daemon", async () => {
    for (const [contracts, expected] of [
      ["4.3.0", { session_sandbox: "off" }],
      ["4.2.0", {}],
    ] as const) {
      const daemon = await fakeDaemon(contracts);
      try {
        const stdin = new PassThrough();
        const done = runBridge({
          repoRoot: "/r",
          host: "claude-code",
          stdin,
          stdout: new PassThrough(),
          initialised: () => true,
          daemon: () => Promise.resolve({ mcp_socket: daemon.path, contracts_version: contracts }),
          sessionSandbox: () => "off",
          serverVersion: "vtc-engine@0.0.0",
        });
        const deadline = Date.now() + 5_000;
        while (daemon.hellos.length === 0 && Date.now() < deadline)
          await new Promise((r) => setTimeout(r, 20));
        stdin.end();
        await done;
        expect(daemon.hellos).toEqual([
          {
            v: 1,
            client: "bridge",
            host: "claude-code",
            contracts_version: CONTRACTS_VERSION,
            ...expected,
          },
        ]);
      } finally {
        await new Promise((r) => daemon.server.close(r));
      }
    }
  });

  it("reads the state from the repo's .claude/settings.local.json, never through a link", () => {
    const repo = initRepo();
    const home = tempHome();
    const settingsPath = join(repo, CLAUDE_LOCAL_SETTINGS);
    expect(CLAUDE_LOCAL_SETTINGS).toBe(".claude/settings.local.json");
    expect(claudeSessionSandboxOf(repo, home)).toMatchObject({
      state: "unknown",
      file: "absent",
    });
    mkdirSync(join(repo, ".claude"));
    writeFileSync(settingsPath, JSON.stringify({ sandbox: { enabled: true } }));
    const partial = claudeSessionSandboxOf(repo, home);
    expect(partial.state).toBe("off");
    expect(partial.missing).toContain("sandbox.allowUnsandboxedCommands");
    expect(partial.missing).toContain(join(home, "token"));
    writeFileSync(
      settingsPath,
      JSON.stringify(mergeSessionSandboxSettings({ sandbox: { enabled: false } }, home)),
    );
    expect(claudeSessionSandboxOf(repo, home)).toEqual({
      state: "on",
      missing: [],
      file: "ok",
      path: settingsPath,
    });
    writeFileSync(settingsPath, "{ not json");
    expect(claudeSessionSandboxOf(repo, home)).toMatchObject({
      state: "unknown",
      file: "unreadable",
    });
    // a cloned repo can commit the file as a link to anywhere: it is not followed
    const elsewhere = join(tempDir(), "settings.json");
    writeFileSync(elsewhere, JSON.stringify(mergeSessionSandboxSettings({}, home)));
    const linked = initRepo();
    mkdirSync(join(linked, ".claude"));
    symlinkSync(elsewhere, join(linked, CLAUDE_LOCAL_SETTINGS));
    expect(claudeSessionSandboxOf(linked, home)).toMatchObject({
      state: "unknown",
      file: "unreadable",
    });
  });

  it("merges the settings, keeping the user's other keys and deny entries", () => {
    const home = "/home/u/.vtc";
    const wanted = claudeSessionSandboxSettings(home).sandbox;
    const merged = mergeSessionSandboxSettings(
      {
        permissions: { allow: ["Bash(ls)"] },
        sandbox: {
          enabled: false,
          allowUnsandboxedCommands: true,
          network: { allowedDomains: ["registry.npmjs.org"] },
          filesystem: { denyRead: ["/secret", wanted.filesystem.denyRead[0]], allowWrite: ["/x"] },
        },
      },
      home,
    );
    expect(merged).toEqual({
      permissions: { allow: ["Bash(ls)"] },
      sandbox: {
        enabled: true,
        allowUnsandboxedCommands: false,
        network: { allowedDomains: ["registry.npmjs.org"] },
        filesystem: {
          denyRead: ["/secret", ...wanted.filesystem.denyRead],
          denyWrite: wanted.filesystem.denyWrite,
          allowWrite: ["/x"],
        },
      },
    });
  });
});

/** A repo whose ignore rules are its own: the user's global excludes file is not consulted. */
const hermeticRepo = (): string => {
  const repo = initRepo();
  git(repo, "config", "core.excludesFile", "/dev/null");
  return repo;
};

describe("vtc install --host claude-code writes the session sandbox (D-an)", () => {
  const adapter = (): HostAdapter & { requests: InstallRequest[] } => {
    const requests: InstallRequest[] = [];
    return {
      requests,
      host: "claude-code",
      install: (r: InstallRequest) => {
        requests.push(r);
        return Promise.resolve({ written: ["/h/.claude/settings.json"], notes: [] });
      },
      dispose: () => Promise.resolve(),
    } as unknown as HostAdapter & { requests: InstallRequest[] };
  };
  const deps =
    (confirm: (q: string) => Promise<boolean>): (() => InstallDeps) =>
    () => ({
      ...defaultInstallDeps(),
      factories: { "claude-code": () => adapter(), codex: () => adapter() },
      home: () => "/h",
      pluginDir: (host) => `/plugins/${host}`,
      platform: "linux",
      timerHost: () => {
        throw new Error("the real launchd or systemd is never touched in tests");
      },
      confirm,
    });

  it("shows the settings, writes them after the user confirms, merged and gitignored", async () => {
    const repo = hermeticRepo();
    const home = tempHome();
    mkdirSync(join(repo, ".claude"));
    const path = join(repo, CLAUDE_LOCAL_SETTINGS);
    writeFileSync(path, JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const questions: string[] = [];
    const { ctx, out } = capture(join(repo), home);
    const cmd = createInstallCommand(deps((q) => (questions.push(q), Promise.resolve(true))));
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    const text = out.join("\n");
    // what is written is shown before the question
    expect(text).toContain(
      JSON.stringify(claudeSessionSandboxSettings(home), null, 2)
        .split("\n")
        .map((line) => `  ${line}`)
        .join("\n"),
    );
    expect(text).toContain(path);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain(path);
    const written = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(written).toEqual(
      mergeSessionSandboxSettings({ permissions: { allow: ["Bash(ls)"] } }, home),
    );
    expect(claudeSessionSandboxOf(repo, home).state).toBe("on");
    // gitignored, without touching a tracked file
    expect(() => git(repo, "check-ignore", "-q", CLAUDE_LOCAL_SETTINGS)).not.toThrow();
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(readFileSync(join(repo, ".git/info/exclude"), "utf8")).toContain(
      "/.claude/settings.local.json\n",
    );
    // run again: already on, nothing asked
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    expect(questions).toHaveLength(1);
    expect(out.join("\n")).toMatch(/session sandbox is already on/);
    // codex installs leave the Claude settings alone
    expect(await cmd.run(["codex"], ctx)).toBe(0);
    expect(questions).toHaveLength(1);
  });

  it("writes nothing when the user declines or there is no terminal to ask in", async () => {
    const repo = hermeticRepo();
    const home = tempHome();
    const { ctx, out } = capture(repo, home);
    expect(
      await createInstallCommand(deps(() => Promise.resolve(false))).run(["claude-code"], ctx),
    ).toBe(0);
    expect(existsSync(join(repo, ".claude"))).toBe(false);
    expect(out.join("\n")).toMatch(
      /not written: code-running roles are refused in your Claude Code session until it is/,
    );
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses a linked .claude, a file it cannot parse, and a tracked file", async () => {
    const yes = createInstallCommand(deps(() => Promise.resolve(true)));
    // a link planted by a cloned repo
    const linked = hermeticRepo();
    const target = tempDir();
    symlinkSync(target, join(linked, ".claude"));
    const a = capture(linked, tempHome());
    expect(await yes.run(["claude-code"], a.ctx)).toBe(1);
    expect(a.err.join("\n")).toMatch(/symbolic link/);
    expect(readdirSync(target)).toEqual([]);
    // a settings file that is not JSON is never overwritten
    const broken = hermeticRepo();
    mkdirSync(join(broken, ".claude"));
    writeFileSync(join(broken, CLAUDE_LOCAL_SETTINGS), "{ nope");
    const b = capture(broken, tempHome());
    expect(await yes.run(["claude-code"], b.ctx)).toBe(1);
    expect(b.err.join("\n")).toMatch(/does not parse/);
    expect(readFileSync(join(broken, CLAUDE_LOCAL_SETTINGS), "utf8")).toBe("{ nope");
    // a tracked settings file cannot be ignored: say how to untrack it
    const tracked = hermeticRepo();
    mkdirSync(join(tracked, ".claude"));
    writeFileSync(join(tracked, CLAUDE_LOCAL_SETTINGS), "{}\n");
    git(tracked, "add", "-f", ".");
    git(tracked, "commit", "-q", "-m", "settings");
    const c = capture(tracked, tempHome());
    expect(await yes.run(["claude-code"], c.ctx)).toBe(1);
    expect(c.err.join("\n")).toMatch(/is tracked by git: run git rm --cached/);
    expect(readFileSync(join(tracked, CLAUDE_LOCAL_SETTINGS), "utf8")).toBe("{}\n");
  });

  it("outside a git repository it says where to run it", async () => {
    const dir = tempDir("vtc-nogit-");
    const { ctx, out } = capture(dir, tempHome());
    const cmd = createInstallCommand(
      deps(() => Promise.reject(new Error("nothing to confirm outside a repo"))),
    );
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    expect(out.join("\n")).toMatch(/not in a git repository/);
    expect(readdirSync(dir)).toEqual([]);
  });
});

const result = (over: Partial<ExecResult> = {}): ExecResult => ({
  code: 0,
  stdout: "",
  stderr: "",
  ...over,
});

const execOf =
  (over: Record<string, Partial<ExecResult>>): Exec =>
  (command, args) =>
    Promise.resolve(
      result(
        {
          "git --version": { stdout: "git version 2.50.0" },
          "claude --version": { stdout: "2.1.296 (Claude Code)" },
          ...over,
        }[[command, ...args].join(" ")] ?? { code: null },
      ),
    );

describe("the gate sandbox (D-al, reading 69)", () => {
  it("passes the user-level gates.allow_unsandboxed to the Gate Runner, never project.yaml's", async () => {
    const seen: Parameters<CreateGateRunner>[0][] = [];
    const build = async (vtcHome: string, allowUnsandboxed?: boolean) => {
      const parts = await buildEngineParts({
        repoRoot: initRepo(),
        vtcHome,
        installToken: TOKEN,
        assets: createDiskAssetBundle({}),
        pullRequests: fakePullRequests(),
        adapterFactories: {},
        ...(allowUnsandboxed === undefined ? {} : { allowUnsandboxed }),
        createGateRunner: (d) => (seen.push(d), fakeGateRunner()),
      });
      await parts.gateRunner.checkWriteScope({} as never).catch(() => undefined);
      return seen.at(-1);
    };
    const home = tempHome();
    // no config: the sandbox is required (the Gate Runner detects the machine's own)
    expect(await build(home)).toMatchObject({ allowUnsandboxed: false });
    expect(seen.at(-1)?.sandbox).toBeUndefined();
    writeFileSync(join(home, "config.yaml"), "version: 1\ngates:\n  allow_unsandboxed: true\n");
    expect(await build(home)).toMatchObject({ allowUnsandboxed: true });
    // a config that does not parse opts nobody in
    writeFileSync(join(home, "config.yaml"), "version: 1\ngates:\n  allow_unsandboxed: maybe\n");
    expect(await build(home)).toMatchObject({ allowUnsandboxed: false });
    expect(await build(home, true)).toMatchObject({ allowUnsandboxed: true });
  });

  it("detects sandbox-exec on macOS and bwrap on Linux, without running a gate", async () => {
    const exists = (p: string): boolean => p === "/usr/bin/sandbox-exec";
    expect(await detectGateSandbox("darwin", exists, execOf({}))).toBe("sandbox-exec");
    expect(await detectGateSandbox("darwin", () => false, execOf({}))).toBeNull();
    expect(
      await detectGateSandbox(
        "linux",
        () => false,
        execOf({ "bwrap --version": { stdout: "bubblewrap 0.11.0\n" } }),
      ),
    ).toBe("bwrap");
    expect(await detectGateSandbox("linux", () => false, execOf({}))).toBeNull();
    expect(await detectGateSandbox("win32", exists, execOf({}))).toBeNull();
  });

  it("vtc doctor reports the sandbox in use, fails without one and warns about the opt-in", async () => {
    const config = (allow: boolean | undefined): UserConfigRead => ({
      ok: true,
      path: "/h/config.yaml",
      config: {
        version: 1,
        env_passthrough: [],
        ...(allow === undefined ? {} : { gates: { allow_unsandboxed: allow } }),
      },
    });
    expect(checkGateSandbox("sandbox-exec", config(undefined))).toEqual({
      name: "gate sandbox",
      status: "ok",
      detail: "gate commands run in sandbox-exec",
    });
    expect(checkGateSandbox("bwrap", config(true))).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(
        /gate commands run in bwrap; gates\.allow_unsandboxed is on in \/h\/config\.yaml/,
      ) as string,
    });
    const none = checkGateSandbox(null, config(false));
    expect(none.status).toBe("fail");
    expect(none.detail).toContain(GATE_SANDBOX.noSandboxReason);
    expect(none.detail).toMatch(/every gate run parks/);
    const optedIn = checkGateSandbox(null, config(true));
    expect(optedIn.status).toBe("warn");
    expect(optedIn.detail).toMatch(/gates run unconfined.*unsandboxed_gate incident/);
    // an unparsable config opts nobody in
    expect(checkGateSandbox(null, { ok: false, path: "/h/config.yaml", error: "bad" }).status).toBe(
      "fail",
    );
    // through the command
    const { ctx, out } = capture("/w", "/h");
    const cmd = createDoctorCommand(() => ({
      exec: execOf({ "claude auth status --json": { stdout: '{"loggedIn":true}' } }),
      versions: { node: "22.17.1" },
      userConfig: () => config(undefined),
      gateSandbox: () => Promise.resolve("sandbox-exec"),
    }));
    expect(await cmd.run([], ctx)).toBe(0);
    expect(out.join("\n")).toMatch(/ok +gate sandbox +gate commands run in sandbox-exec/);
  });

  it("vtc doctor reports the repo's Claude session sandbox and what it misses", async () => {
    const repo = initRepo();
    const home = tempHome();
    const doctor = () =>
      createDoctorCommand((c) => ({
        exec: execOf({ "claude auth status --json": { stdout: '{"loggedIn":true}' } }),
        versions: { node: "22.17.1" },
        sessionSandbox: () =>
          Promise.resolve(c.cwd === repo ? claudeSessionSandboxOf(repo, c.vtcHome) : null),
      }));
    const run = async (): Promise<string> => {
      const { ctx, out } = capture(repo, home);
      expect(await doctor().run([], ctx)).toBe(0);
      return out.join("\n");
    };
    expect(await run()).toMatch(
      /warn +session +no Claude session sandbox in .*settings\.local\.json.*run vtc install --host claude-code/,
    );
    mkdirSync(join(repo, ".claude"));
    writeFileSync(
      join(repo, CLAUDE_LOCAL_SETTINGS),
      JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }),
    );
    expect(await run()).toMatch(
      new RegExp(`warn +session +.*is off; missing: .*${join(home, "token")}`),
    );
    writeFileSync(
      join(repo, CLAUDE_LOCAL_SETTINGS),
      JSON.stringify(mergeSessionSandboxSettings({}, home)),
    );
    expect(await run()).toMatch(/ok +session +the Claude session sandbox is on/);
  });
});

describe("the human channel (D-an, reading 71)", () => {
  const discovery = { contracts_version: CONTRACTS_VERSION };

  it("the cli's plain engine client never calls a human-only tool", async () => {
    const calls: string[] = [];
    const inner: EngineClient = {
      call: (tool) => (calls.push(tool), Promise.resolve({} as never)),
      close: () => Promise.resolve(),
    };
    const { ctx } = capture("/w", "/h", () => Promise.resolve(inner));
    const client = await ctx.engine();
    for (const tool of HUMAN_ONLY_TOOLS)
      await expect(client.call(tool, {} as never)).rejects.toThrow(humanChannelRequired(tool));
    await client.call("status", {});
    expect(calls).toEqual(["status"]);
    expect(guardHumanOnly(inner)).not.toBe(inner);
  });

  it("sends the install token only after a confirmation in an interactive terminal", async () => {
    const questions: string[] = [];
    const deps = (interactive: boolean, answer: boolean) => ({
      interactive: () => interactive,
      confirm: (q: string) => (questions.push(q), Promise.resolve(answer)),
      installToken: () => TOKEN,
    });
    await expect(
      humanCliHello("approve", "approve the plan of run r1", discovery, deps(false, true)),
    ).rejects.toThrow(/interactive terminal/);
    expect(questions).toEqual([]);
    await expect(
      humanCliHello("approve", "approve the plan of run r1", discovery, deps(true, false)),
    ).rejects.toThrow(/not confirmed/);
    expect(questions).toEqual([expect.stringContaining("approve the plan of run r1")]);
    await expect(
      humanCliHello("answer", "answer E-1", { contracts_version: "4.2.0" }, deps(true, true)),
    ).rejects.toThrow(/vtc engine --stop/);
    const hello = await humanCliHello("answer", "answer E-1", discovery, deps(true, true));
    expect(hello).toEqual({
      v: 1,
      client: "cli",
      host: null,
      contracts_version: CONTRACTS_VERSION,
      install_token: TOKEN,
    });
    expect(EngineSocketHelloSchema.safeParse(hello).success).toBe(true);
  });

  it("no other cli source puts the install token in a hello", () => {
    const src = fileURLToPath(new URL("../src/", import.meta.url));
    const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard", "*.ts"], {
      cwd: src,
      encoding: "utf8",
    })
      .split("\n")
      .filter((f) => f !== "");
    const sending = files.filter((f) =>
      readFileSync(join(src, f), "utf8").includes("install_token"),
    );
    expect(sending).toEqual(["human-channel.ts"]);
  });
});
