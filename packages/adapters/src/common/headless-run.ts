/**
 * The hardened headless launcher (§15, AD-25 rule 4): one child per role run, started as the
 * leader of its own process group (the spawner's job), stdout kept line by line as the run
 * transcript, and supervision by a hard wall timeout and an optional idle timeout (no stdout line
 * for that long). Stopping a run, for either timeout or for `kill()`, signals the whole group:
 * SIGINT (Claude ends its turn cleanly on it), then SIGTERM after `interruptGraceMs`, then SIGKILL
 * after `termGraceMs` (`HEADLESS_DEFAULTS`). Once the process has exited, the host-specific
 * `outcome` reader turns the stream and the exit into a `HostOutcome`; why the launcher stopped
 * the run (`RunExit.stop`) is input to it, never a replacement for what the stream says
 * (AD-25 rule 5).
 */
import { createInterface } from "node:readline";
import {
  HEADLESS_DEFAULTS,
  type HeadlessRun,
  type HostCommand,
  type HostErrorCause,
  type HostOutcome,
} from "@vtc/shared";
import type { ProcessExit, Spawner } from "./process.js";

/** Why the launcher stopped a run: its wall timeout, its idle timeout, or `kill()`. */
export type StopCause = Extract<HostErrorCause, "timeout" | "idle" | "killed">;

export interface RunStop {
  readonly cause: StopCause;
  /** One sentence for `HostOutcome` `error.message`. */
  readonly message: string;
}

/** How a run ended, as the host-specific `outcome` reader sees it. */
export interface RunExit extends ProcessExit {
  /** The last few KB of stderr (hosts print start-up and sign-in errors there). */
  readonly stderrTail: string;
  /** When the run ended (ISO), so a reader can turn "try again in 2 hours" into a time. */
  readonly endedAt: string;
  /** Set when the launcher stopped the run (the first reason wins); `null` when it ended itself. */
  readonly stop: RunStop | null;
}

export interface HeadlessRunOptions {
  readonly command: HostCommand;
  readonly cwd: string;
  /** Hard wall-clock limit (`SpawnRoleRequest.timeoutMs`). */
  readonly timeoutMs: number;
  /** No stdout line for this long stops the run (`SpawnRoleRequest.idleTimeoutMs`). Absent: none. */
  readonly idleTimeoutMs?: number;
  /** After SIGINT, how long to wait before SIGTERM. Default `HEADLESS_DEFAULTS.interruptGraceMs`. */
  readonly interruptGraceMs?: number;
  /**
   * After SIGTERM, how long to wait before SIGKILL; also the longest wait for stdout to close
   * after the exit. Default `HEADLESS_DEFAULTS.termGraceMs`.
   */
  readonly termGraceMs?: number;
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
  /** Called once when the run has settled (the adapter stops tracking it). */
  readonly onSettled?: () => void;
}

const STDERR_TAIL_CHARS = 4000;

const stopMessage = (command: string, cause: StopCause, options: HeadlessRunOptions): string => {
  switch (cause) {
    case "timeout":
      return `${command} ran longer than its wall timeout of ${String(options.timeoutMs)} ms and was stopped`;
    case "idle":
      return `${command} printed nothing for ${String(options.idleTimeoutMs)} ms (its idle timeout) and was stopped`;
    case "killed":
      return `${command} was stopped by VTC`;
  }
};

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
  const interruptGraceMs = options.interruptGraceMs ?? HEADLESS_DEFAULTS.interruptGraceMs;
  const termGraceMs = options.termGraceMs ?? HEADLESS_DEFAULTS.termGraceMs;
  const seen: string[] = [];
  const wakeups = new Set<() => void>();
  const timers = new Set<NodeJS.Timeout>();
  let ended = false;
  let stderrTail = "";
  // an object, so the callbacks' writes are visible to the type checker
  // `exited`: the process is gone, so a timer firing while its stdout drains is no reason to stop
  const state: { stop: RunStop | null; stdoutDone: boolean; exited: boolean } = {
    stop: null,
    stdoutDone: false,
    exited: false,
  };

  const later = (ms: number, run: () => void): NodeJS.Timeout => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      run();
    }, ms);
    timer.unref();
    timers.add(timer);
    return timer;
  };

  const wake = (): void => {
    for (const resolve of wakeups) resolve();
    wakeups.clear();
  };

  /** SIGINT, then SIGTERM, then SIGKILL on the group; the first reason to stop is kept. */
  const stop = (cause: StopCause): void => {
    if (ended || state.exited || state.stop !== null) return;
    state.stop = { cause, message: stopMessage(options.command.command, cause, options) };
    child.kill("SIGINT");
    later(interruptGraceMs, () => {
      child.kill("SIGTERM");
      later(termGraceMs, () => {
        child.kill("SIGKILL");
      });
    });
  };

  let idleTimer: NodeJS.Timeout | undefined;
  const armIdle = (): void => {
    const idle = options.idleTimeoutMs;
    if (idle === undefined || state.stop !== null) return;
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      timers.delete(idleTimer);
    }
    idleTimer = later(idle, () => {
      stop("idle");
    });
  };

  const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
  reader.on("line", (line) => {
    seen.push(line);
    armIdle();
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

  later(options.timeoutMs, () => {
    stop("timeout");
  });
  armIdle();

  const settled: Promise<HostOutcome> = (async () => {
    const exit = await child.exited;
    state.exited = true;
    // a process that never started has no stdout to drain; one that did gets a bounded drain,
    // since something it started may still hold the pipe
    if (exit.error === null) {
      let drain: NodeJS.Timeout | undefined;
      await Promise.race([
        stdoutClosed,
        new Promise<void>((resolve) => {
          drain = setTimeout(resolve, termGraceMs);
        }),
      ]);
      clearTimeout(drain);
    }
    if (!state.stdoutDone) {
      reader.close();
      child.stdout.destroy();
    }
    const endedAt = (options.now?.() ?? new Date()).toISOString();
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    ended = true;
    wake();
    options.onSettled?.();
    return options.outcome(seen, { ...exit, stderrTail, endedAt, stop: state.stop });
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
      stop("killed");
      await settled;
    },
  };
};
