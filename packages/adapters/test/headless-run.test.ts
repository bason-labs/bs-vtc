import { afterEach, describe, expect, it, vi } from "vitest";
import { AD9_FORBIDDEN_MARKERS, type HostOutcome } from "@vtc/shared";
import { startHeadlessRun, type RunExit } from "../src/common/headless-run.js";
import { childEnvironment, createNodeSpawner, nodeSpawner } from "../src/common/process.js";
import { fakeSpawner } from "./support/fake-spawner.js";

const COMMAND = { command: "host", args: ["run"], env: {} };
const echoOutcome = (lines: readonly string[], exit: RunExit): HostOutcome => ({
  kind: "error",
  message: JSON.stringify({
    lines,
    code: exit.code,
    signal: exit.signal,
    stderr: exit.stderrTail,
    stop: exit.stop,
  }),
  retryable: true,
  tokens: null,
  cost_usd: null,
});
const details = (outcome: HostOutcome) =>
  JSON.parse(outcome.kind === "error" ? outcome.message : "{}") as {
    lines: string[];
    code: number | null;
    signal: string | null;
    stderr: string;
    stop: RunExit["stop"];
  };

describe("headless launcher (§15 hardened launcher)", () => {
  it("keeps every stdout line, replays them to each reader, and passes stderr to the outcome", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      spawner,
      outcome: echoOutcome,
    });
    const proc = processes[0]!;
    const early: string[] = [];
    const reading = (async () => {
      for await (const line of run.lines()) early.push(line);
    })();
    proc.emit("a", "b");
    proc.writeStderr("warning: x");
    proc.exit(3);
    const outcome = details(await run.wait());
    await reading;
    expect(outcome).toEqual({
      lines: ["a", "b"],
      code: 3,
      signal: null,
      stderr: "warning: x",
      stop: null,
    });
    expect(early).toEqual(["a", "b"]);
    const late: string[] = [];
    for await (const line of run.lines()) late.push(line);
    expect(late).toEqual(["a", "b"]);
    expect(run.pid).toBe(4242);
    expect(run.command).toBe(COMMAND);
  });

  it("stops a run that outlives its wall timeout: SIGINT, then SIGTERM, then SIGKILL, and says why (AD-25 rule 4)", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.obeysInt = false;
      p.obeysTerm = false;
    });
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 10,
      interruptGraceMs: 10,
      termGraceMs: 10,
      spawner,
      outcome: echoOutcome,
    });
    const outcome = details(await run.wait());
    expect(processes[0]?.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
    expect(outcome.stop).toEqual({
      cause: "timeout",
      message: "host ran longer than its wall timeout of 10 ms and was stopped",
    });
  });

  it("a host that ends its turn on SIGINT gets no harsher signal", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 10,
      interruptGraceMs: 10,
      termGraceMs: 10,
      spawner,
      outcome: echoOutcome,
    });
    expect(details(await run.wait()).stop?.cause).toBe("timeout");
    expect(processes[0]?.signals).toEqual(["SIGINT"]);
  });

  it("escalates to SIGTERM when SIGINT is ignored, and stops there when the host obeys it", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.obeysInt = false;
    });
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 10,
      interruptGraceMs: 10,
      termGraceMs: 10_000,
      spawner,
      outcome: echoOutcome,
    });
    expect(details(await run.wait()).signal).toBe("SIGTERM");
    expect(processes[0]?.signals).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("stops a run that prints no line for its idle timeout; every line restarts the clock", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 60_000,
      idleTimeoutMs: 80,
      interruptGraceMs: 10,
      termGraceMs: 10,
      spawner,
      outcome: echoOutcome,
    });
    const proc = processes[0]!;
    const started = Date.now();
    // a line every 30 ms keeps the run alive past several idle periods
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      proc.emit(`tick ${String(i)}`);
    }
    expect(proc.finished).toBe(false);
    const outcome = details(await run.wait());
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
    expect(outcome.lines).toHaveLength(6);
    expect(outcome.stop).toEqual({
      cause: "idle",
      message: "host printed nothing for 80 ms (its idle timeout) and was stopped",
    });
    expect(proc.signals).toEqual(["SIGINT"]);
  });

  it("without an idle timeout a quiet run is left alone until its wall timeout", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 120,
      interruptGraceMs: 10,
      termGraceMs: 10,
      spawner,
      outcome: echoOutcome,
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(processes[0]?.finished).toBe(false);
    expect(details(await run.wait()).stop?.cause).toBe("timeout");
  });

  it("kill() stops the run with cause killed and resolves once it has exited; calling it again is harmless", async () => {
    const { spawner, processes } = fakeSpawner();
    const settled: string[] = [];
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      spawner,
      outcome: echoOutcome,
      onSettled: () => settled.push("done"),
    });
    await run.kill();
    await run.kill();
    expect(processes[0]?.signals).toEqual(["SIGINT"]);
    const outcome = details(await run.wait());
    expect(outcome.signal).toBe("SIGINT");
    expect(outcome.stop).toEqual({ cause: "killed", message: "host was stopped by VTC" });
    expect(settled).toEqual(["done"]);
  });

  it("the first reason to stop is the one reported", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.obeysInt = false;
    });
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 30,
      idleTimeoutMs: 5_000,
      interruptGraceMs: 50,
      termGraceMs: 10,
      spawner,
      outcome: echoOutcome,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await run.kill();
    expect(details(await run.wait()).stop?.cause).toBe("timeout");
    expect(processes[0]?.signals).toEqual(["SIGINT", "SIGTERM"]);
  });

  it("writes the input to stdin and closes it, and stamps when the run ended", async () => {
    const { spawner, processes } = fakeSpawner();
    let seen: RunExit | null = null;
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      spawner,
      input: "the task pack",
      now: () => new Date("2026-10-13T08:00:00Z"),
      outcome: (lines, exit) => {
        seen = exit;
        return echoOutcome(lines, exit);
      },
    });
    const proc = processes[0]!;
    expect(proc.options.stdin).toBe("pipe");
    expect(await proc.stdinText()).toBe("the task pack");
    proc.exit(0);
    await run.wait();
    expect(seen).toMatchObject({ endedAt: "2026-10-13T08:00:00.000Z" });
  });

  it("does not wait forever for a stdout something else still holds after the exit", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      termGraceMs: 20,
      spawner,
      outcome: echoOutcome,
    });
    const proc = processes[0]!;
    proc.emit("a");
    // the leader is gone, but its stdout never closes
    proc.settleOnly(0);
    expect(details(await run.wait()).lines).toEqual(["a"]);
  });

  it("a process that cannot start settles with its start error", async () => {
    const { spawner } = fakeSpawner((p) => {
      p.failToStart(new Error("spawn host ENOENT"));
    });
    let seen: RunExit | null = null;
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      spawner,
      outcome: (lines, exit) => {
        seen = exit;
        return echoOutcome(lines, exit);
      },
    });
    await run.wait();
    expect(seen).toMatchObject({ code: null, error: { message: "spawn host ENOENT" } });
  });
});

describe("child environment (AD-25 rule 4)", () => {
  const BASE = {
    HOME: "/Users/dev",
    PATH: "/usr/bin:/bin",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: "/var/folders/x/T/",
    CLAUDE_CONFIG_DIR: "/Users/dev/.claude-work",
    CODEX_HOME: "/Users/dev/.codex-work",
    VTC_HOME: "/Users/dev/.vtc",
    https_proxy: "http://proxy.local:3128",
    NODE_OPTIONS: "--require /tmp/x.js",
    GIT_DIR: "/elsewhere/.git",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    AWS_SECRET_ACCESS_KEY: "secret",
    GITHUB_TOKEN: "ghp_x",
    UNRELATED: "1",
  };

  it("passes an allowlist: the real HOME, PATH, locale, temp, the hosts' and VTC's homes and proxies", () => {
    expect(childEnvironment(BASE, {})).toEqual({
      HOME: "/Users/dev",
      PATH: "/usr/bin:/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TMPDIR: "/var/folders/x/T/",
      CLAUDE_CONFIG_DIR: "/Users/dev/.claude-work",
      CODEX_HOME: "/Users/dev/.codex-work",
      VTC_HOME: "/Users/dev/.vtc",
      https_proxy: "http://proxy.local:3128",
    });
  });

  it("never passes a credential variable, whatever the parent has", () => {
    const parent: Record<string, string> = { ...BASE };
    for (const marker of AD9_FORBIDDEN_MARKERS) {
      if (/^[A-Z_]+$/.test(marker)) parent[marker] = "x";
    }
    const env = childEnvironment(parent, {});
    for (const name of Object.keys(parent)) {
      if (/^[A-Z_]+$/.test(name) && AD9_FORBIDDEN_MARKERS.some((m) => m === name)) {
        expect(env).not.toHaveProperty(name);
      }
    }
  });

  it("adds the command's own variables, and skips unset ones", () => {
    expect(
      childEnvironment(
        { PATH: "/bin", HOME: undefined },
        { CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "1" },
      ),
    ).toEqual({ PATH: "/bin", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "1" });
  });
});

describe.skipIf(process.platform === "win32")("Node spawner environment", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("starts the host with the allowlisted environment only", async () => {
    vi.stubEnv("VTC_TEST_UNLISTED", "leak");
    const run = startHeadlessRun({
      command: { command: "/bin/sh", args: ["-c", "env"], env: { VTC_TEST_ADDED: "yes" } },
      cwd: process.cwd(),
      timeoutMs: 10_000,
      spawner: nodeSpawner,
      outcome: echoOutcome,
    });
    const lines = details(await run.wait()).lines;
    expect(lines).toContain(`HOME=${process.env.HOME ?? ""}`);
    expect(lines).toContain("VTC_TEST_ADDED=yes");
    expect(lines.some((l) => l.startsWith("VTC_TEST_UNLISTED="))).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("Node spawner (no orphans, §15)", () => {
  it("closes stdin and kills the whole process tree", async () => {
    const run = startHeadlessRun({
      // a stand-in host: reports stdin state, starts a grandchild, then waits on it
      command: {
        command: "/bin/sh",
        args: [
          "-c",
          'if read -r _; then echo open; else echo closed; fi; sleep 30 & echo "$!"; wait',
        ],
        env: {},
      },
      cwd: process.cwd(),
      timeoutMs: 10_000,
      interruptGraceMs: 200,
      termGraceMs: 500,
      spawner: nodeSpawner,
      outcome: echoOutcome,
    });
    const lines: string[] = [];
    for await (const line of run.lines()) {
      lines.push(line);
      if (lines.length === 2) break;
    }
    expect(lines[0]).toBe("closed");
    const grandchild = Number(lines[1]);
    expect(grandchild).toBeGreaterThan(0);
    await run.kill();
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 3_000 }).toBe(false);
  });

  it("kills what the host left running in its group once the host has exited", async () => {
    const run = startHeadlessRun({
      // the leader exits at once, leaving a group member that no longer holds stdout
      command: {
        command: "/bin/sh",
        args: ["-c", 'sleep 30 >/dev/null 2>&1 & echo "$!"'],
        env: {},
      },
      cwd: process.cwd(),
      timeoutMs: 10_000,
      spawner: nodeSpawner,
      outcome: echoOutcome,
    });
    const leftover = Number(details(await run.wait()).lines[0]);
    expect(leftover).toBeGreaterThan(0);
    const alive = (): boolean => {
      try {
        process.kill(leftover, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 3_000 }).toBe(false);
  });

  it("settles even when a process that left the group keeps stdout open", async () => {
    const started = Date.now();
    const run = startHeadlessRun({
      // the leader starts a detached (new session) grandchild that inherits stdout, then exits
      command: {
        command: process.execPath,
        args: [
          "-e",
          "require('node:child_process').spawn('sleep', ['3'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref(); console.log('started');",
        ],
        env: {},
      },
      cwd: process.cwd(),
      timeoutMs: 10_000,
      termGraceMs: 200,
      spawner: createNodeSpawner({ drainMs: 200 }),
      outcome: echoOutcome,
    });
    const outcome = details(await run.wait());
    expect(outcome.lines).toEqual(["started"]);
    expect(outcome.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("an idle timeout stops the whole process group and leaves no orphans (AD-25 rule 4)", async () => {
    const run = startHeadlessRun({
      // a stand-in host that prints its grandchild's pid, then hangs without another line; a
      // background job of a non-interactive shell ignores SIGINT, so the escalation is needed
      command: {
        command: "/bin/sh",
        args: ["-c", 'sleep 30 & echo "$!"; wait'],
        env: {},
      },
      cwd: process.cwd(),
      timeoutMs: 20_000,
      idleTimeoutMs: 300,
      interruptGraceMs: 200,
      termGraceMs: 200,
      spawner: nodeSpawner,
      outcome: echoOutcome,
    });
    const outcome = details(await run.wait());
    expect(outcome.stop?.cause).toBe("idle");
    const grandchild = Number(outcome.lines[0]);
    expect(grandchild).toBeGreaterThan(0);
    const alive = (): boolean => {
      try {
        process.kill(grandchild, 0);
        return true;
      } catch {
        return false;
      }
    };
    await expect.poll(alive, { timeout: 3_000 }).toBe(false);
  });

  it("reports a missing binary as a start error, not a crash", async () => {
    const run = startHeadlessRun({
      command: { command: "vtc-no-such-host-binary", args: [], env: {} },
      cwd: process.cwd(),
      timeoutMs: 5_000,
      spawner: nodeSpawner,
      outcome: (_lines, exit) => ({
        kind: "error",
        message: exit.error?.message ?? "none",
        retryable: false,
        tokens: null,
        cost_usd: null,
      }),
    });
    const outcome = await run.wait();
    expect(outcome.kind === "error" && outcome.message).toContain("ENOENT");
  });
});

describe("Node spawner on Windows (known gap, spec §4.4 windows-x64)", () => {
  it.todo("starts npm .cmd shims (PATHEXT lookup, no shell) and kills the whole process tree");
});
