import { describe, expect, it } from "vitest";
import { COMMANDS, detectRuntime, loadStorage, main } from "../src/index.js";

const run = (...argv: string[]) => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(argv, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err };
};

describe("vtc cli smoke", () => {
  it("prints help listing every command", () => {
    const { code, out } = run("--help");
    expect(code).toBe(0);
    for (const c of COMMANDS) expect(out.join("\n")).toContain(c.name);
  });
  it("prints a version that proves the wiring", () => {
    const { code, out } = run("--version");
    expect(code).toBe(0);
    expect(out[0]).toMatch(
      /^vtc 0\.0\.0 \(vtc-engine, contracts 2\.0\.0, hosts claude-code\/codex/,
    );
  });
  it("reports unimplemented and unknown commands", () => {
    expect(run("init").code).toBe(2);
    const unknown = run("deploy");
    expect(unknown.code).toBe(64);
    expect(unknown.err[0]).toContain("unknown command");
  });
});

describe("command registry", () => {
  it("has unique command names, one file each", () => {
    const names = COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("statusline-tee");
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
