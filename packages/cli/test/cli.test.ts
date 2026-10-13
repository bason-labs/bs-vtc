import { describe, expect, it } from "vitest";
import { COMMANDS, main } from "../src/index.js";

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
      /^vtc 0\.0\.0 \(vtc-engine, contracts 1\.0\.0, hosts claude-code\/codex/,
    );
  });
  it("reports unimplemented and unknown commands", () => {
    expect(run("init").code).toBe(2);
    const unknown = run("deploy");
    expect(unknown.code).toBe(64);
    expect(unknown.err[0]).toContain("unknown command");
  });
});
