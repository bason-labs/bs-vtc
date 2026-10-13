/**
 * The MCP surface (AD-4 Check): every tool accepts valid input, rejects invalid input with a schema
 * error, and an out-of-order submit is rejected; the socket protocol (AD-12 Check): a valid hello
 * can call `status`, a bad hello or another contracts MAJOR gets `ok: false` and is closed; two
 * processes share one daemon; the stdio bridge relays bytes.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  engineSocketFile,
  ENGINE_MCP_TOOLS,
  EngineSocketWelcomeSchema,
  type EngineMcpToolName,
} from "@vtc/shared";
import {
  callTool,
  connectEngineClient,
  engineSocketAnswers,
  MCP_PROTOCOL_VERSION,
  runStdioBridge,
  SUPPORTED_MCP_PROTOCOL_VERSIONS,
  serveEngineSocket,
  toolDefinitions,
  type EngineSocketServer,
} from "../../src/mcp/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { CLAUDE, createHarness, type Harness } from "../helpers/engine-harness.js";

const servers: EngineSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  cleanupDirs();
});

const VERSIONS = { engine: "vtc-engine@0.0.0", contracts: CONTRACTS_VERSION };

const socketFor = async (h: Harness): Promise<EngineSocketServer> => {
  const home = mkdtempSync(join(tmpdir(), "vh-"));
  const server = await serveEngineSocket({
    path: join(home, engineSocketFile(h.repo)),
    host: h.engine,
    versions: VERSIONS,
    installToken: "i".repeat(43),
  });
  servers.push(server);
  return server;
};

const parsed = (result: Record<string, unknown>): unknown => result.structuredContent;

describe("tool surface (AD-4)", () => {
  it("lists exactly the frozen tools, each with object input and output schemas", () => {
    const tools = toolDefinitions();
    expect(tools.map((t) => t.name)).toEqual(ENGINE_MCP_TOOLS.map((t) => t.name));
    for (const tool of tools) {
      expect((tool.inputSchema as { type?: string }).type).toBe("object");
      expect((tool.outputSchema as { type?: string }).type).toBe("object");
    }
  });

  const invalid: Record<EngineMcpToolName, unknown> = {
    start: { request: "", track: "feature" },
    next: { run: "../etc" },
    submit: { kind: "result" },
    status: { extra: true },
    escalations: { run: 7 },
    answer: { escalation: "X-1" },
    approve: { gates: [], decision: "maybe" },
    change_request: { artifact: "interface_contract", summary: "x", detail: "y" },
    consult: { advisor: "advisor_estimator" },
    pause: { run: "" },
    resume: { nope: 1 },
  };
  it.each(Object.entries(invalid))(
    "%s rejects invalid input with a schema error",
    async (tool, input) => {
      const h = createHarness();
      const result = await callTool(h.engine, tool, input, CLAUDE);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("invalid");
      await h.release();
    },
  );

  it("accepts valid input for every tool, end to end", async () => {
    const h = createHarness();
    const start = parsed(
      await callTool(
        h.engine,
        "start",
        { request: "Password reset", track: "feature", repo: "existing", has_ui: false },
        CLAUDE,
      ),
    ) as { run: string };
    expect(start.run).toMatch(/^r\d{8}-\d{6}$/);
    const next = parsed(await callTool(h.engine, "next", {}, CLAUDE)) as {
      actions: { type: string; action_id?: string; role?: string }[];
    };
    const action = next.actions[0];
    expect(action).toMatchObject({ type: "spawn_role", role: "repo_cartographer" });
    expect(parsed(await callTool(h.engine, "status", {}, CLAUDE))).toMatchObject({
      run: { id: start.run, phase: "discover" },
    });
    expect(parsed(await callTool(h.engine, "escalations", {}, CLAUDE))).toEqual({
      run: start.run,
      escalations: [],
    });
    // out of order: a result for an action that was never dispatched
    const outOfOrder = parsed(
      await callTool(
        h.engine,
        "submit",
        { kind: "result", action_id: "a-77", result: { role: "ba", exit: "done", summary: "x" } },
        CLAUDE,
      ),
    );
    expect(outOfOrder).toMatchObject({ accepted: false, rejection: { reason: "unknown_action" } });
    // a malformed result for an open action is logged as a schema rejection and re-dispatched
    const malformed = parsed(
      await callTool(
        h.engine,
        "submit",
        {
          kind: "result",
          action_id: action?.action_id,
          result: { role: "repo_cartographer", exit: "done" },
        },
        CLAUDE,
      ),
    );
    expect(malformed).toMatchObject({ accepted: false, rejection: { reason: "schema" } });
    expect(parsed(await callTool(h.engine, "pause", {}, CLAUDE))).toMatchObject({ paused: true });
    expect(parsed(await callTool(h.engine, "resume", {}, CLAUDE))).toMatchObject({ paused: false });
    const approve = await callTool(
      h.engine,
      "approve",
      {
        gates: ["G1"],
        decision: "approve",
        frozen: [{ path: ".vtc/spec/spec.md", sha256: "a".repeat(64) }],
      },
      CLAUDE,
    );
    expect(approve).toMatchObject({ isError: true });
    expect(JSON.stringify(approve.content)).toContain("conflict");
    const cr = await callTool(
      h.engine,
      "change_request",
      { artifact: "spec", summary: "x", detail: "y" },
      CLAUDE,
    );
    expect(JSON.stringify(cr.content)).toContain("no frozen spec");
    const answer = await callTool(
      h.engine,
      "answer",
      { escalation: "E-9", answer: { option: "hint", who_should_have_caught: "qa" } },
      CLAUDE,
    );
    expect(JSON.stringify(answer.content)).toContain("no escalation E-9");
    await h.release();
  });

  it("speaks MCP through the official SDK: initialize, ping, tools/list, errors", async () => {
    const h = createHarness();
    const server = await socketFor(h);
    const hello = { v: 1, client: "cli", host: null, contracts_version: CONTRACTS_VERSION };
    const replies = (
      await rawExchange(server.path, [
        hello,
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "t", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "ping" },
        { jsonrpc: "2.0", id: 3, method: "tools/list" },
        { jsonrpc: "2.0", id: 4, method: "nope" },
        { hello: 1 },
        "not json",
      ])
    ).map((l) => JSON.parse(l) as Record<string, unknown>);
    const byId = (id: number) => replies.find((r) => r.id === id);
    expect(byId(1)).toMatchObject({
      result: { protocolVersion: "2025-03-26", serverInfo: { name: "vtc" } },
    });
    expect(byId(2)).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    expect((byId(3)?.result as { tools: { name: string }[] }).tools.map((t) => t.name)).toEqual(
      ENGINE_MCP_TOOLS.map((t) => t.name),
    );
    expect(byId(4)).toMatchObject({ error: { code: -32601 } });
    expect(replies.some((r) => (r.error as { code?: number } | undefined)?.code === -32600)).toBe(
      true,
    );
    expect(replies.some((r) => (r.error as { code?: number } | undefined)?.code === -32700)).toBe(
      true,
    );
    await h.release();
  });
  it("negotiates the protocol version against the versions the SDK supports", async () => {
    const h = createHarness();
    const server = await socketFor(h);
    const hello = { v: 1, client: "cli", host: null, contracts_version: CONTRACTS_VERSION };
    const init = async (protocolVersion: string) =>
      JSON.parse(
        (
          await rawExchange(server.path, [
            hello,
            {
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                protocolVersion,
                capabilities: {},
                clientInfo: { name: "t", version: "0" },
              },
            },
          ])
        )[1] ?? "{}",
      ) as { result?: { protocolVersion?: string } };
    for (const version of SUPPORTED_MCP_PROTOCOL_VERSIONS)
      expect((await init(version)).result?.protocolVersion).toBe(version);
    for (const unknown of ["1999-01-01", "2099-12-31"])
      expect((await init(unknown)).result?.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    await h.release();
  });
});

const rawExchange = (path: string, lines: readonly unknown[]): Promise<string[]> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    let data = "";
    socket.on("connect", () => {
      for (const line of lines)
        socket.write(`${typeof line === "string" ? line : JSON.stringify(line)}\n`);
    });
    socket.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    socket.on("close", () => {
      resolve(data.split("\n").filter((l) => l !== ""));
    });
    socket.on("error", reject);
    setTimeout(() => socket.end(), 400);
  });

describe("socket protocol (AD-12 rule 3)", () => {
  it("engineSocketAnswers: true while a daemon answers the hello, false for a silent path", async () => {
    const h = createHarness();
    const server = await socketFor(h);
    expect(await engineSocketAnswers(server.path)).toBe(true);
    // another contracts MAJOR still gets a welcome (ok: false): the holder is alive
    expect(await engineSocketAnswers(server.path, { contractsVersion: "99.0.0" })).toBe(true);
    await server.close();
    expect(await engineSocketAnswers(server.path)).toBe(false);
    expect(await engineSocketAnswers(join(tempDir(), "none.sock"))).toBe(false);
    await h.release();
  });
  it("engineSocketAnswers: false for a listener that never sends a welcome", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "vh-")), "mute.sock");
    const held: Socket[] = [];
    const mute = createServer((socket) => {
      held.push(socket);
    });
    await new Promise<void>((resolve) => {
      mute.listen(path, resolve);
    });
    try {
      expect(await engineSocketAnswers(path, { timeoutMs: 200 })).toBe(false);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => {
        mute.close(() => {
          resolve();
        });
      });
    }
  });
  it("a client with a valid hello can call status through the typed EngineClient", async () => {
    const h = createHarness();
    await h.engine.start(
      { request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const server = await socketFor(h);
    const client = await connectEngineClient(server.path);
    const status = await client.call("status", {});
    expect(status.run.phase).toBe("discover");
    expect(server.connections()).toEqual({ bridge: 0, cli: 1 });
    // a bare cli hello is no human channel (D-an): the human-only tools are refused
    await expect(
      client.call("answer", {
        escalation: "E-1",
        answer: { option: "x", who_should_have_caught: "qa" },
      }),
    ).rejects.toThrow(/forbidden: answer records a human decision/);
    await client.close();
    await h.release();
  });
  it("answers a malformed hello and another contracts MAJOR with ok:false, then closes", async () => {
    const h = createHarness();
    const server = await socketFor(h);
    const bad = await rawExchange(server.path, ["not json"]);
    expect(EngineSocketWelcomeSchema.parse(JSON.parse(bad[0] ?? "{}"))).toMatchObject({
      ok: false,
    });
    const major = await rawExchange(server.path, [
      { v: 1, client: "cli", host: null, contracts_version: "99.0.0" },
    ]);
    expect(JSON.parse(major[0] ?? "{}")).toMatchObject({
      ok: false,
      error: expect.stringContaining("incompatible") as unknown,
    });
    const bridgeWithoutHost = await rawExchange(server.path, [
      { v: 1, client: "bridge", host: null, contracts_version: CONTRACTS_VERSION },
    ]);
    expect(JSON.parse(bridgeWithoutHost[0] ?? "{}")).toMatchObject({ ok: false });
    await expect(connectEngineClient(server.path, "99.1.0")).rejects.toThrow(/refused/);
    await h.release();
  });
  it("reads nothing after a refused hello, even lines that arrived in the same chunk", async () => {
    const h = createHarness();
    await h.engine.start(
      { request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const server = await socketFor(h);
    const replies = await rawExchange(server.path, [
      "not json",
      { v: 1, client: "cli", host: null, contracts_version: CONTRACTS_VERSION },
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "pause", arguments: {} } },
    ]);
    expect(replies).toHaveLength(1);
    expect(JSON.parse(replies[0] ?? "{}")).toMatchObject({ ok: false });
    expect(h.engine.status({}).run.paused).toBe(false);
    await h.release();
  });
  it("refuses a socket path longer than sun_path allows", async () => {
    const h = createHarness();
    await expect(
      serveEngineSocket({
        path: `/tmp/${"x".repeat(120)}.sock`,
        host: h.engine,
        versions: VERSIONS,
        installToken: "i".repeat(43),
      }),
    ).rejects.toThrow(/longer/);
    await h.release();
  });
  it("two processes share one daemon over the socket", async () => {
    const h = createHarness();
    const { run } = await h.engine.start(
      { request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const server = await socketFor(h);
    const script = join(tempDir("vtc-client-"), "client.mjs");
    writeFileSync(
      script,
      `import { connect } from "node:net";
const s = connect(process.argv[2]);
let buf = "";
const send = (m) => s.write(JSON.stringify(m) + "\\n");
s.on("connect", () => send({ v: 1, client: "bridge", host: "claude-code", contracts_version: process.argv[3] }));
s.on("data", (c) => {
  buf += c;
  const lines = buf.split("\\n"); buf = lines.pop();
  for (const line of lines) {
    const m = JSON.parse(line);
    if ("ok" in m) { send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "child", version: "0" } } }); continue; }
    if (m.id === 1) { send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status", arguments: {} } }); continue; }
    if (m.id === 2) { process.stdout.write(JSON.stringify(m.result.structuredContent.run.id)); s.end(); }
  }
});
`,
    );
    const runChild = (): Promise<string> =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [script, server.path, CONTRACTS_VERSION], {
          stdio: ["ignore", "pipe", "inherit"],
        });
        let out = "";
        child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
        child.on("error", reject);
        child.on("close", () => {
          resolve(out);
        });
      });
    const [a, b] = await Promise.all([runChild(), runChild()]);
    expect([a, b]).toEqual([JSON.stringify(run), JSON.stringify(run)]);
    await h.release();
  }, 20_000);
  it("the stdio bridge relays MCP bytes both ways after the handshake", async () => {
    const h = createHarness();
    await h.engine.start(
      { request: "Idea", track: "feature", repo: "existing", has_ui: false, risk_hints: [] },
      CLAUDE,
    );
    const server = await socketFor(h);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    const bridge = runStdioBridge({ path: server.path, host: "claude-code", stdin, stdout });
    stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "next", arguments: {} } })}\n`,
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(server.connections().bridge).toBe(1);
    stdin.end();
    await bridge;
    const reply = JSON.parse(out.trim().split("\n")[0] ?? "{}") as {
      result: { structuredContent: { actions: { role?: string }[] } };
    };
    expect(reply.result.structuredContent.actions[0]?.role).toBe("repo_cartographer");
    await h.release();
  });
});
