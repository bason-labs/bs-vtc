/**
 * The hardened headless launcher (§15): one child per role run, stdout kept line by line as the
 * run transcript, a hard timeout with a forced kill, and a normalised outcome once the process
 * has exited. Host specifics come in through `outcome` (the adapter's pure stream reader).
 */
import { createInterface } from "node:readline";
import type { HeadlessRun, HostCommand, HostOutcome } from "@vtc/shared";
import type { ProcessExit, Spawner } from "./process.js";

/** How a run ended, as the host-specific `outcome` reader sees it. */
export interface RunExit extends ProcessExit {
  /** The last few KB of stderr (hosts print start-up and sign-in errors there). */
  readonly stderrTail: string;
  /** When the run ended (ISO), so a reader can turn "try again in 2 hours" into a time. */
  readonly endedAt: string;
}

export interface HeadlessRunOptions {
  readonly command: HostCommand;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly spawner: Spawner;
  /**
   * Written to the child's stdin, which is then closed (the prompt, kept out of argv: argv has a
   * per-argument size limit and other local users can read it). Absent: stdin is closed.
   */
  readonly input?: string;
  /** Clock for `RunExit.endedAt`. */
  readonly now?: () => Date;
  /** Pure: the outcome of a finished run from its stdout lines and how it exited. */
  readonly outcome: (lines: readonly string[], exit: RunExit) => HostOutcome;
  /** Grace between SIGTERM and SIGKILL, and the longest wait for stdout after the exit. */
  readonly killGraceMs?: number;
  /** Called once when the run has settled (the adapter stops tracking it). */
  readonly onSettled?: () => void;
}

const STDERR_TAIL_CHARS = 4000;
const DEFAULT_KILL_GRACE_MS = 5000;

export const startHeadlessRun = (options: HeadlessRunOptions): HeadlessRun => {
  const child = options.spawner(options.command, {
    cwd: options.cwd,
    stdin: options.input === undefined ? "closed" : "pipe",
  });
  if (options.input !== undefined && child.stdin !== null) {
    // a host that exits before reading its input must not crash the engine with EPIPE
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input, "utf8");
  }
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const seen: string[] = [];
  const wakeups = new Set<() => void>();
  let ended = false;
  let stderrTail = "";
  // an object, so the callbacks' writes are visible to the type checker
  const state = { timedOut: false, stdoutDone: false };
  let killTimer: NodeJS.Timeout | undefined;

  const wake = (): void => {
    for (const resolve of wakeups) resolve();
    wakeups.clear();
  };

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    seen.push(line);
    wake();
  });
  const stdoutClosed = new Promise<void>((resolve) => {
    reader.once("close", () => {
      state.stdoutDone = true;
      resolve();
    });
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  const terminate = (): void => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      child.kill("SIGKILL");
    }, killGraceMs);
    killTimer.unref();
  };

  const timeout = setTimeout(() => {
    state.timedOut = true;
    terminate();
  }, options.timeoutMs);
  timeout.unref();

  const settled: Promise<HostOutcome> = (async () => {
    const exit = await child.exited;
    // a process that never started has no stdout to drain; one that did gets a bounded drain,
    // since something it started may still hold the pipe
    if (exit.error === null) {
      let drain: NodeJS.Timeout | undefined;
      await Promise.race([
        stdoutClosed,
        new Promise<void>((resolve) => {
          drain = setTimeout(resolve, killGraceMs);
        }),
      ]);
      clearTimeout(drain);
    }
    if (!state.stdoutDone) {
      reader.close();
      child.stdout.destroy();
    }
    const endedAt = (options.now?.() ?? new Date()).toISOString();
    clearTimeout(timeout);
    if (killTimer !== undefined) clearTimeout(killTimer);
    ended = true;
    wake();
    options.onSettled?.();
    if (state.timedOut) {
      return {
        kind: "error",
        message: `${options.command.command} timed out after ${String(options.timeoutMs)} ms and was killed`,
        retryable: true,
        tokens: null,
        cost_usd: null,
      } satisfies HostOutcome;
    }
    return options.outcome(seen, { ...exit, stderrTail, endedAt });
  })();

  return {
    command: options.command,
    pid: child.pid,
    async *lines() {
      let index = 0;
      for (;;) {
        while (index < seen.length) {
          const line = seen[index];
          index += 1;
          if (line !== undefined) yield line;
        }
        if (ended) return;
        await new Promise<void>((resolve) => wakeups.add(resolve));
      }
    },
    wait: () => settled,
    async kill() {
      if (!ended) terminate();
      await settled;
    },
  };
};
