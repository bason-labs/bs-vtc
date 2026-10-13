import { describe, expect, expectTypeOf, it } from "vitest";
import { runDaemon } from "@vtc/engine";
import type { EngineClient, EngineDeps, EngineToolInput, EngineToolOutput } from "@vtc/shared";
import {
  COMMANDS,
  composeEngineDeps,
  createCommandContext,
  detectRuntime,
  loadStorage,
  main,
  resolveVtcHome,
  type CommandContext,
  type EngineParts,
} from "../src/index.js";

const run = async (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const ctx = createCommandContext(
    { out: (l) => out.push(l), err: (l) => err.push(l) },
    "/work/app",
    "/home/u/.vtc",
  );
  const code = await main(argv, ctx);
  return { code, out, err };
};

describe("vtc cli smoke", () => {
  it("prints help listing every command", async () => {
    const { code, out } = await run("--help");
    expect(code).toBe(0);
    for (const c of COMMANDS) expect(out.join("\n")).toContain(c.name);
  });
  it("prints a version that proves the wiring", async () => {
    const { code, out } = await run("--version");
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^vtc 0\.0\.0 \(vtc-engine, contracts 3\.0\.0, hosts claude-code\/codex/,
    );
  });
  it("runs a command through its spec; reports unknown commands", async () => {
    const init = await run("init", "--force");
    expect(init.code).toBe(2);
    expect(init.err[0]).toContain("not implemented");
    const unknown = await run("deploy");
    expect(unknown.code).toBe(64);
    expect(unknown.err[0]).toContain("unknown command");
  });
});

describe("command registry", () => {
  it("has unique command names, one file each, each with a run handler", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("statusline-tee");
    for (const c of COMMANDS) expect(typeof c.run).toBe("function");
  });
});

describe("composition seam (AD-19)", () => {
  it("the cli's wiring produces exactly what the engine's runDaemon takes", () => {
    expectTypeOf(composeEngineDeps).returns.toEqualTypeOf<EngineDeps>();
    expectTypeOf(runDaemon).parameter(0).toEqualTypeOf<EngineDeps>();
    expectTypeOf<EngineParts>().toExtend<Omit<EngineDeps, "versions" | "now">>();
  });
  it("control commands reach the daemon over MCP through a typed client", () => {
    expectTypeOf<CommandContext["engine"]>().returns.resolves.toEqualTypeOf<EngineClient>();
    expectTypeOf<EngineToolInput<"pause">>().toEqualTypeOf<{ run?: string | undefined }>();
    expectTypeOf<EngineToolOutput<"pause">>().toHaveProperty("paused").toEqualTypeOf<boolean>();
  });
  it("opens the engine client lazily and once", async () => {
    let connects = 0;
    const client: EngineClient = {
      call: () => Promise.reject(new Error("unused")),
      close: () => Promise.resolve(),
    };
    const ctx = createCommandContext({ out: () => {}, err: () => {} }, "/w", "/h", () => {
      connects += 1;
      return Promise.resolve(client);
    });
    expect(connects).toBe(0);
    expect(await ctx.engine()).toBe(client);
    await ctx.engine();
    expect(connects).toBe(1);
  });
  it("resolves the VTC home from $VTC_HOME or ~/.vtc", () => {
    expect(resolveVtcHome({ VTC_HOME: "/tmp/v" })).toBe("/tmp/v");
    expect(resolveVtcHome({})).toMatch(/\.vtc$/);
  });
});

describe("storage driver selection (AD-2)", () => {
  it("uses node:sqlite under Node", async () => {
    expect(detectRuntime()).toBe("node");
    const open = await loadStorage();
    const storage = open({ path: ":memory:" });
    expect(storage.driver).toBe("node:sqlite");
    storage.close();
  });
});
