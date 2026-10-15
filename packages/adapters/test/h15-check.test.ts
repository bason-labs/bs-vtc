/**
 * The H-15 live checks' pure parts (scripts/h15-check-*.ts, spine §5 reading 239) and the
 * round-5 `vtc` shim of the D-cl `claude-arm` check. The probe script and the shim are run here
 * for real with `sh`, on temp files only; the live checks themselves never run in tests.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseDclArgs } from "../scripts/dcl-check-args.js";
import { hookResponses } from "../scripts/dcl-check-lib.js";
import { parseH15Args } from "../scripts/h15-check-args.js";
import {
  atLimit,
  claudeStreamFacts,
  CODEX_REFUSAL_PROBE_MODEL,
  hookCallSummary,
  parseProbeResults,
  sandboxProbeScript,
  shellQuote,
  unifiedWindowReadings,
  usageCommandPercents,
  vtcHookShim,
  withCodexEphemeral,
} from "../scripts/h15-check-lib.js";
import { fixtureLines } from "./support/fixtures.js";

const dirs: string[] = [];
const temp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-h15-test-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("parseH15Args", () => {
  it("needs a check and an output directory; --model only where a check takes one", () => {
    expect(parseH15Args(["codex-signed-out", "--out", "/tmp/o"])).toEqual({
      target: "codex-signed-out",
      out: "/tmp/o",
    });
    expect(parseH15Args(["claude-sandbox", "--out", "/o", "--model", "haiku"])).toMatchObject({
      model: "haiku",
    });
    expect(() => parseH15Args([])).toThrow(/name a check/u);
    expect(() => parseH15Args(["codex-web", "--out", "/o"])).toThrow(/must be one of/u);
    expect(() => parseH15Args(["claude-strict"])).toThrow(/--out/u);
    expect(() => parseH15Args(["codex-limit", "--out", "/o", "--model", "x"])).toThrow(
      /not a flag of codex-limit/u,
    );
    expect(() => parseH15Args(["claude-strict", "--out", "/o", "--model", "--x"])).toThrow(
      /needs a value/u,
    );
    expect(() => parseH15Args(["claude-strict", "--out", "/o", "--model", "a b"])).toThrow(
      /model id/u,
    );
    expect(() => parseH15Args(["claude-strict", "--out", "/o", "--bogus", "1"])).toThrow(
      /unknown flag/u,
    );
  });
});

describe("parseDclArgs --vtc-bin (round-5 claude-arm items)", () => {
  it("takes the cli the shim runs, for claude-arm only", () => {
    expect(parseDclArgs(["claude-arm", "--out", "/o", "--vtc-bin", "/b.js"])).toMatchObject({
      vtcBin: "/b.js",
    });
    expect(() => parseDclArgs(["codex-web", "--out", "/o", "--vtc-bin", "/b.js"])).toThrow(
      /not a flag of codex-web/u,
    );
  });
});

describe("withCodexEphemeral", () => {
  it("adds --ephemeral right after exec, once, and refuses anything but a fresh exec", () => {
    expect(withCodexEphemeral(["exec", "--json", "-"])).toEqual([
      "exec",
      "--ephemeral",
      "--json",
      "-",
    ]);
    expect(withCodexEphemeral(["exec", "--ephemeral", "-"])).toEqual(["exec", "--ephemeral", "-"]);
    expect(() => withCodexEphemeral(["mcp", "list"])).toThrow(/fresh/u);
    expect(() => withCodexEphemeral(["exec", "resume", "--json"])).toThrow(/fresh/u);
    expect(CODEX_REFUSAL_PROBE_MODEL).toMatch(/^vtc-probe-/u);
  });
});

describe("atLimit", () => {
  const snapshot = (pcts: (number | null)[], modelLimits = 0) => ({
    host: "codex" as const,
    source: "app_server" as const,
    windows: pcts.map((used_pct, i) => ({
      kind: "five_hour" as const,
      label: `w${String(i)}`,
      window_minutes: 300,
      used_pct,
      resets_at: null,
    })),
    model_limits: Array.from({ length: modelLimits }, () => ({
      model: "m",
      resets_at: null,
      observed_at: "2026-10-15T00:00:00.000Z",
    })),
    updated_at: null,
  });
  it("is true only for a window at 100% or a per-model limit (2026-10-15 read 15% and 2%: false)", () => {
    expect(atLimit(snapshot([15, 2]))).toBe(false);
    expect(atLimit(snapshot([null]))).toBe(false);
    expect(atLimit(snapshot([100, 2]))).toBe(true);
    expect(atLimit(snapshot([3], 1))).toBe(true);
  });
});

describe("sandboxProbeScript", () => {
  it("reports open/denied/ok per target without printing any file's contents", () => {
    const dir = temp();
    const secret = join(dir, "secret");
    writeFileSync(secret, "SENTINEL-TEXT");
    const results = join(dir, "results.txt");
    const script = join(dir, "probe.sh");
    writeFileSync(
      script,
      sandboxProbeScript(
        [
          { name: "secret", path: secret, kind: "read" },
          { name: "missing", path: join(dir, "nope"), kind: "read" },
          { name: "free", path: join(dir, "free.txt"), kind: "write" },
          // a write that cannot succeed, for any user: its directory does not exist
          { name: "locked", path: join(dir, "no-such-dir", "x"), kind: "write" },
        ],
        [
          { name: "true", argv: ["true"] },
          { name: "false", argv: ["sh", "-c", "exit 3"] },
        ],
        results,
      ),
    );
    const stdout = execFileSync("sh", [script, "escape"], { encoding: "utf8" });
    expect(stdout).toBe("");
    const text = readFileSync(results, "utf8");
    expect(text).not.toContain("SENTINEL-TEXT");
    expect(parseProbeResults(text)).toEqual({
      escape: {
        "read secret": "open",
        "read missing": "denied",
        "write free": "open",
        "write locked": "denied",
        "tool true": "ok",
        "tool false": "failed 3",
      },
    });
    expect(readFileSync(join(dir, "free.txt"), "utf8")).toBe("probe");
  });

  it("refuses a label the results format cannot carry, and quotes paths", () => {
    expect(() =>
      sandboxProbeScript([{ name: "Bad Label", path: "/x", kind: "read" }], [], "/r"),
    ).toThrow(/bad probe label/u);
    expect(shellQuote("a'b $c")).toBe(`'a'\\''b $c'`);
    expect(parseProbeResults("sandboxed read x open\nnoise\nsandboxed done\n")).toEqual({
      sandboxed: { "read x": "open" },
    });
  });
});

describe("vtcHookShim (round-5 claude-arm items)", () => {
  it("records a hook call and passes stdin, output and status through; other commands go straight through", () => {
    const dir = temp();
    const calls = join(dir, "calls");
    mkdirSync(calls);
    // a stand-in for the real cli: echoes its stdin and argv, then exits 3
    const fake = join(dir, "fake-vtc");
    writeFileSync(fake, '#!/bin/sh\ncat\necho "args:$*"\necho warn >&2\nexit 3\n', { mode: 0o755 });
    const shim = join(dir, "vtc");
    writeFileSync(shim, vtcHookShim([fake], calls, "VTC_HEADLESS_ROLE"), { mode: 0o755 });
    const input = JSON.stringify({
      hook_event_name: "SessionStart",
      agent_type: "vtc:vtc-qa-judge",
      session_id: "s",
      cwd: "/w",
    });
    let status = 0;
    let stdout = "";
    try {
      execFileSync(shim, ["hook", "session-start", "--host", "claude-code"], {
        input,
        env: { ...process.env, VTC_HEADLESS_ROLE: "vtc:vtc-qa-judge" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      const e = error as { status: number; stdout: Buffer };
      status = e.status;
      stdout = e.stdout.toString();
    }
    expect(status).toBe(3);
    expect(stdout).toBe(`${input}args:hook session-start --host claude-code\n`);
    const files = readdirSync(calls);
    const base = files[0]?.replace(/\.[a-z]+$/u, "") ?? "";
    const read = (ext: string) => readFileSync(join(calls, `${base}.${ext}`), "utf8");
    expect(
      hookCallSummary({
        argv: read("argv"),
        input: read("in"),
        role: read("role"),
        code: read("code"),
        stdout: read("out"),
        stderr: read("err"),
      }),
    ).toEqual({
      argv: "hook session-start --host claude-code",
      event: "SessionStart",
      inputKeys: ["agent_type", "cwd", "hook_event_name", "session_id"],
      agentType: "vtc:vtc-qa-judge",
      roleEnv: "vtc:vtc-qa-judge",
      exitCode: 3,
      stdoutBytes: Buffer.byteLength(`${input}args:hook session-start --host claude-code\n`),
      stderrBytes: 5,
    });
    // the MCP bridge streams on stdin: never buffered, never recorded
    let bridge = "";
    try {
      execFileSync(shim, ["engine", "--mcp"], { input: "x\n", stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      bridge = (error as { stdout: Buffer }).stdout.toString();
    }
    expect(bridge).toBe("x\nargs:engine --mcp\n");
    expect(readdirSync(calls)).toHaveLength(files.length);
  });

  it("summarizes an input that is not JSON, and an unset role variable", () => {
    expect(
      hookCallSummary({
        argv: "hook x",
        input: "nope",
        role: "<unset>",
        code: "",
        stdout: "",
        stderr: "",
      }),
    ).toMatchObject({
      event: null,
      inputKeys: [],
      agentType: null,
      exitCode: null,
      roleEnv: "<unset>",
    });
  });
});

describe("stream facts", () => {
  it("hookResponses lists each hook's exit and whether it printed (recorded arm streams)", () => {
    const before = fixtureLines("claude-code/stream-arm-success.jsonl").filter((l) => l !== "");
    expect(hookResponses(before).map((h) => h.exitCode)).toContain(127);
    const after = fixtureLines("claude-code/stream-arm-vtc-on-path.jsonl").filter((l) => l !== "");
    expect(hookResponses(after)).toContainEqual({
      hook: "SessionStart:startup",
      exitCode: 0,
      outcome: "success",
      printed: false,
    });
  });

  it("claudeStreamFacts reads the sign-in source, what loaded, and the result", () => {
    const facts = claudeStreamFacts(
      fixtureLines("claude-code/stream-usage-unit.jsonl").filter((l) => l !== ""),
    );
    expect(facts).toMatchObject({
      apiKeySource: "none",
      mcpServers: 0,
      tools: [],
      hooksStarted: 0,
      result: { subtype: "success", is_error: false },
    });
    expect(claudeStreamFacts([])).toMatchObject({ apiKeySource: null, result: null });
  });

  it("unifiedWindowReadings and usageCommandPercents read the two sides of the H-10 comparison", () => {
    expect(
      unifiedWindowReadings(fixtureLines("claude-code/stream-usage-unit.jsonl").filter((l) => l)),
    ).toEqual({
      five_hour: { utilization: 0.13, resetsAt: 1792082400 },
      seven_day: { utilization: 0.73, resetsAt: 1792418400 },
    });
    expect(
      usageCommandPercents(
        "You are currently using your subscription\n\nCurrent session: 14% used · resets Oct 15 at 11:39pm (Asia/Saigon)\nCurrent week (all models): 73% used · resets Oct 19 at 8:59pm (Asia/Saigon)\n",
      ),
    ).toEqual({ session: 14, week: 73 });
    expect(usageCommandPercents("nothing")).toEqual({ session: null, week: null });
  });
});
