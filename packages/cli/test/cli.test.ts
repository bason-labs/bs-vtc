import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, expectTypeOf, it } from "vitest";
import { runDaemon } from "@vtc/engine";
import type { EngineClient, EngineDeps, EngineToolInput, EngineToolOutput } from "@vtc/shared";
import {
  COMMANDS,
  composeEngineDeps,
  createCommandContext,
  detectRuntime,
  ensureInstallToken,
  installTokenPath,
  loadStorage,
  readInstallToken,
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
      /^vtc 0\.0\.0 \(vtc-engine, contracts 4\.0\.0, hosts claude-code\/codex/,
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

describe("install token (AD-5 rule 2, ENGINE_INSTANCE.tokenFile)", () => {
  const homes: string[] = [];
  const home = (): string => {
    const dir = join(mkdtempSync(join(tmpdir(), "vtc-token-")), "vtc-home");
    homes.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of homes) rmSync(join(dir, ".."), { recursive: true, force: true });
  });
  it("creates 256 random bits once, mode 0600, and returns the same token afterwards", () => {
    const vtcHome = home();
    const token = ensureInstallToken(vtcHome);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(installTokenPath(vtcHome)).toBe(join(vtcHome, "token"));
    expect(statSync(installTokenPath(vtcHome)).mode & 0o777).toBe(0o600);
    expect(ensureInstallToken(vtcHome)).toBe(token);
    expect(readInstallToken(vtcHome)).toBe(token);
  });
  it("concurrent creators agree on one token and leave no temporary files", async () => {
    const vtcHome = home();
    const tokens = await Promise.all(
      Array.from({ length: 8 }, () => Promise.resolve().then(() => ensureInstallToken(vtcHome))),
    );
    expect(new Set(tokens).size).toBe(1);
    expect(readInstallToken(vtcHome)).toBe(tokens[0]);
    expect(readdirSync(vtcHome)).toEqual(["token"]);
  });
  it.runIf(process.platform !== "win32")("refuses a token others can read", () => {
    const vtcHome = home();
    ensureInstallToken(vtcHome);
    chmodSync(installTokenPath(vtcHome), 0o644);
    expect(() => readInstallToken(vtcHome)).toThrow(/readable by other users/);
    expect(() => ensureInstallToken(vtcHome)).toThrow(/readable by other users/);
  });
  it("refuses a file that holds no token", () => {
    const vtcHome = home();
    ensureInstallToken(vtcHome);
    writeFileSync(installTokenPath(vtcHome), "hunter2\n", { mode: 0o600 });
    expect(() => readInstallToken(vtcHome)).toThrow(/does not hold/);
  });
});
