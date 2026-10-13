import { describe, expect, it } from "vitest";
import type { HostOutcome } from "@vtc/shared";
import { startHeadlessRun, type RunExit } from "../src/common/headless-run.js";
import { createNodeSpawner, nodeSpawner } from "../src/common/process.js";
import { fakeSpawner } from "./support/fake-spawner.js";

const COMMAND = { command: "host", args: ["run"], env: {} };
const echoOutcome = (lines: readonly string[], exit: RunExit): HostOutcome => ({
  kind: "error",
  message: JSON.stringify({ lines, code: exit.code, signal: exit.signal, stderr: exit.stderrTail }),
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
    expect(outcome).toEqual({ lines: ["a", "b"], code: 3, signal: null, stderr: "warning: x" });
    expect(early).toEqual(["a", "b"]);
    const late: string[] = [];
    for await (const line of run.lines()) late.push(line);
    expect(late).toEqual(["a", "b"]);
    expect(run.pid).toBe(4242);
    expect(run.command).toBe(COMMAND);
  });

  it("kills a run that outlives its timeout, escalating to SIGKILL", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.obeysTerm = false;
    });
    const run = startHeadlessRun({
      command: COMMAND,
      cwd: "/w",
      timeoutMs: 10,
      killGraceMs: 10,
      spawner,
      outcome: echoOutcome,
    });
    const outcome = await run.wait();
    expect(processes[0]?.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome).toEqual({
      kind: "error",
      message: "host timed out after 10 ms and was killed",
      retryable: true,
      tokens: null,
      cost_usd: null,
    });
  });

  it("kill() stops the run and resolves once it has exited; calling it again is harmless", async () => {
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
    expect(processes[0]?.signals).toEqual(["SIGTERM"]);
    expect(details(await run.wait()).signal).toBe("SIGTERM");
    expect(settled).toEqual(["done"]);
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
      killGraceMs: 20,
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
      killGraceMs: 500,
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
      killGraceMs: 200,
      spawner: createNodeSpawner({ drainMs: 200 }),
      outcome: echoOutcome,
    });
    const outcome = details(await run.wait());
    expect(outcome.lines).toEqual(["started"]);
    expect(outcome.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_500);
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
