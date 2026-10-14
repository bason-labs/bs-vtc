import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AD9_FORBIDDEN_MARKERS,
  HEADLESS_DEFAULTS,
  type HostOutcome,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createRunLauncher } from "../src/common/dispatch.js";
import { startHeadlessRun, type RunExit } from "../src/common/headless-run.js";
import { describeExit } from "../src/common/outcome.js";
import {
  absoluteSearchPath,
  childEnvironment,
  createNodeSpawner,
  nodeSpawner,
} from "../src/common/process.js";
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

  it("a timer that fires after the process exited, while its stdout drains, is no reason to stop it", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 20,
      idleTimeoutMs: 20,
      termGraceMs: 200,
      spawner,
      outcome: echoOutcome,
    });
    const proc = processes[0]!;
    // the leader exits by itself; something it started holds stdout past both timeouts
    proc.settleOnly(1);
    const outcome = details(await run.wait());
    expect(outcome.stop).toBeNull();
    expect(outcome.code).toBe(1);
    expect(proc.signals).toEqual([]);
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

describe("headless launcher defaults and bounds", () => {
  it("without grace options waits HEADLESS_DEFAULTS: SIGINT, then SIGTERM, then SIGKILL (AD-25 rule 4)", async () => {
    vi.useFakeTimers();
    try {
      const { spawner, processes } = fakeSpawner((p) => {
        p.obeysInt = false;
        p.obeysTerm = false;
      });
      const run = startHeadlessRun({
        command: COMMAND,
        cwd: "/w",
        timeoutMs: 1_000,
        spawner,
        outcome: echoOutcome,
      });
      const signals = () => processes[0]?.signals;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(signals()).toEqual(["SIGINT"]);
      await vi.advanceTimersByTimeAsync(HEADLESS_DEFAULTS.interruptGraceMs - 1);
      expect(signals()).toEqual(["SIGINT"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals()).toEqual(["SIGINT", "SIGTERM"]);
      await vi.advanceTimersByTimeAsync(HEADLESS_DEFAULTS.termGraceMs - 1);
      expect(signals()).toEqual(["SIGINT", "SIGTERM"]);
      await vi.advanceTimersByTimeAsync(1);
      expect(signals()).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
      expect(details(await run.wait()).stop?.cause).toBe("timeout");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the first lines and a bounded tail, and a late reader resumes at the oldest kept line", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      spawner,
      outcome: echoOutcome,
      transcriptLimits: { headLines: 2, tailChars: 8, lineChars: 5 },
    });
    const proc = processes[0]!;
    proc.emit("init", "h2", "m1", "m2", "m3", "toolong-line", "t1", "t2");
    proc.stdout.write("crlf\r\nlast");
    proc.exit(0);
    const outcome = details(await run.wait());
    // the head always stays; of the rest only the newest lines within 8 characters
    expect(outcome.lines).toEqual(["init", "h2", "crlf", "last"]);
    const late: string[] = [];
    for await (const line of run.lines()) late.push(line);
    expect(late).toEqual(["init", "h2", "crlf", "last"]);
  });

  it("cuts a line longer than the limit even before its newline arrives", async () => {
    const { spawner, processes } = fakeSpawner();
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 5_000,
      spawner,
      outcome: echoOutcome,
      transcriptLimits: { headLines: 10, tailChars: 100, lineChars: 4 },
    });
    const proc = processes[0]!;
    for (let i = 0; i < 50; i += 1) proc.stdout.write("xxxxxxxxxx");
    proc.stdout.write("\nok\n");
    proc.exit(0);
    expect(details(await run.wait()).lines).toEqual(["xxxx", "ok"]);
  });

  it("redacts secrets in the stderr tail an exit message carries (AD-18)", () => {
    const secret = `sk-ant-${"a".repeat(30)}`;
    const message = describeExit(
      "host",
      {
        code: 1,
        signal: null,
        error: null,
        stderrTail: `auth failed for ${secret}\n`,
        endedAt: "2026-10-14T09:00:00.000Z",
        stop: null,
      },
      "without a result",
    );
    expect(message).toContain("host exited 1 without a result: auth failed for [REDACTED:");
    expect(message).not.toContain(secret);
  });
});

describe("run launcher argv guard (AD-9, AD-25 rules 1-2)", () => {
  const ROLE_REQUEST = { cwd: "/w", prompt: "p", timeoutMs: 5_000 } as SpawnRoleRequest;
  const ISOLATED = ["exec", "--sandbox", "read-only", "-c", 'approval_policy="never"'];

  it("refuses to start an argv that misses an isolation flag or carries a forbidden one", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.exit(0);
    });
    const runs = createRunLauncher({ host: "codex", spawner, outcome: echoOutcome });
    const marker = AD9_FORBIDDEN_MARKERS[0];
    for (const command of [
      { command: "codex", args: ["exec"], env: {} },
      { command: "codex", args: [...ISOLATED, `--${marker}`], env: {} },
      { command: "codex", args: ISOLATED, env: { [marker]: "1" } },
      { command: "codex", args: [...ISOLATED, "--approve-for-me"], env: {} },
    ]) {
      expect(() => runs.start(command, ROLE_REQUEST), command.args.join(" ")).toThrow(
        /refusing to start codex/,
      );
    }
    expect(processes).toEqual([]);
    const started = runs.start({ command: "codex", args: ISOLATED, env: {} }, ROLE_REQUEST);
    if (started.dispatch !== "headless") throw new Error("expected a headless run");
    await started.run.wait();
    expect(processes).toHaveLength(1);
    await runs.dispose();
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

  it("keeps only the absolute PATH entries: a relative, `.` or empty one would search the worktree (§15)", () => {
    expect(absoluteSearchPath("rel:/usr/bin::.:./node_modules/.bin:/bin:~/bin:")).toBe(
      "/usr/bin:/bin",
    );
    expect(childEnvironment({ PATH: "./node_modules/.bin:/usr/bin:" }, {})).toEqual({
      PATH: "/usr/bin",
    });
    // whatever spells it, and also a PATH the command itself would add
    expect(childEnvironment({ Path: ":/bin" }, { PATH: "x:/usr/bin" })).toEqual({
      Path: "/bin",
      PATH: "/usr/bin",
    });
  });

  it("passes the user's env_passthrough names, but never a host credential variable (D-ak, AD-9)", () => {
    const parent = {
      ...BASE,
      CORP_PROXY_PAC: "http://pac.local",
      ANTHROPIC_API_KEY: "sk-x",
      OPENAI_API_KEY: "sk-y",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
    };
    const env = childEnvironment(parent, {}, [
      "CORP_PROXY_PAC",
      "SSH_AUTH_SOCK",
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "NOT_SET",
    ]);
    expect(env).toMatchObject({
      CORP_PROXY_PAC: "http://pac.local",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
    });
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "NOT_SET",
    ]) {
      expect(env).not.toHaveProperty(name);
    }
    expect(childEnvironment(BASE, {})).not.toHaveProperty("SSH_AUTH_SOCK");
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

describe.skipIf(process.platform === "win32")("Node spawner PATH (§15)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("never runs a host binary planted in the working directory through a relative or empty PATH entry", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "vtc-planted-"));
    dirs.push(cwd);
    mkdirSync(join(cwd, "rel"));
    for (const path of [join(cwd, "rel", "vtc-fake-host"), join(cwd, "vtc-fake-host")]) {
      writeFileSync(path, "#!/bin/sh\necho PLANTED\n");
      chmodSync(path, 0o755);
    }
    for (const PATH of ["rel:/usr/bin:/bin", "/usr/bin:/bin:", ".:/usr/bin:/bin"]) {
      vi.stubEnv("PATH", PATH);
      let seen: RunExit | null = null;
      const run = startHeadlessRun({
        command: { command: "vtc-fake-host", args: [], env: {} },
        cwd,
        timeoutMs: 10_000,
        spawner: nodeSpawner,
        outcome: (lines, exit) => {
          seen = exit;
          return echoOutcome(lines, exit);
        },
      });
      const outcome = details(await run.wait());
      expect(outcome.lines, PATH).not.toContain("PLANTED");
      expect(seen, PATH).toMatchObject({ error: { code: "ENOENT" } });
    }
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
