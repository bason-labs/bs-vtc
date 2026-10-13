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
}

export interface HeadlessRunOptions {
  readonly command: HostCommand;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly spawner: Spawner;
  /** Pure: the outcome of a finished run from its stdout lines and how it exited. */
  readonly outcome: (lines: readonly string[], exit: RunExit) => HostOutcome;
  /** Grace between SIGTERM and SIGKILL. */
  readonly killGraceMs?: number;
  /** Called once when the run has settled (the adapter stops tracking it). */
  readonly onSettled?: () => void;
}

const STDERR_TAIL_CHARS = 4000;
const DEFAULT_KILL_GRACE_MS = 5000;

export const startHeadlessRun = (options: HeadlessRunOptions): HeadlessRun => {
  const child = options.spawner(options.command, { cwd: options.cwd, stdin: "closed" });
  const seen: string[] = [];
  const wakeups = new Set<() => void>();
  let ended = false;
  let stderrTail = "";
  // an object, so the timer callback's write is visible to the type checker
  const state = { timedOut: false };
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
    reader.once("close", resolve);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
  });

  const terminate = (): void => {
    child.kill("SIGTERM");
    killTimer ??= setTimeout(() => {
      child.kill("SIGKILL");
    }, options.killGraceMs ?? DEFAULT_KILL_GRACE_MS);
    killTimer.unref();
  };

  const timeout = setTimeout(() => {
    state.timedOut = true;
    terminate();
  }, options.timeoutMs);
  timeout.unref();

  const settled: Promise<HostOutcome> = (async () => {
    const exit = await child.exited;
    // a process that never started has no stdout to drain
    if (exit.error === null) await stdoutClosed;
    else reader.close();
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
    return options.outcome(seen, { ...exit, stderrTail });
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
