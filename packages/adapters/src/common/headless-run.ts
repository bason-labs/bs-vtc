/**
 * The hardened headless launcher (§15, AD-25 rule 4): one child per role run, started as the
 * leader of its own process group (the spawner's job), stdout kept line by line as the run
 * transcript (bounded: see {@link TranscriptLimits}), and supervision by a hard wall timeout and an optional idle timeout (no stdout line
 * for that long). Stopping a run, for either timeout or for `kill()`, signals the whole group:
 * SIGINT (Claude ends its turn cleanly on it), then SIGTERM after `interruptGraceMs`, then SIGKILL
 * after `termGraceMs` (`HEADLESS_DEFAULTS`). Once the process has exited, the host-specific
 * `outcome` reader turns the stream and the exit into a `HostOutcome`; why the launcher stopped
 * the run (`RunExit.stop`) is input to it, never a replacement for what the stream says
 * (AD-25 rule 5).
 */
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

/**
 * How much of a run's stdout the launcher keeps, so a run's memory is bounded by bytes and not
 * only by its wall timeout. The first `headLines` lines are always kept (where each host names
 * its session); after them, later lines up to `tailChars` characters in all, the oldest dropped
 * first (the terminal events the outcome needs come last). A line longer than `lineChars` keeps
 * only its start. A reader of `lines()` that falls behind the dropped lines resumes at the oldest
 * line still kept.
 */
export interface TranscriptLimits {
  readonly headLines: number;
  readonly tailChars: number;
  readonly lineChars: number;
}

export const TRANSCRIPT_LIMITS: TranscriptLimits = {
  headLines: 200,
  tailChars: 16 * 1024 * 1024,
  lineChars: 4 * 1024 * 1024,
};

/** The kept lines, numbered as the run printed them (a dropped line keeps its number). */
const createTranscript = (limits: TranscriptLimits) => {
  const head: string[] = [];
  let tail: string[] = [];
  // `tail[offset]` is the oldest kept later line; its number in the run is `tailStart`
  let offset = 0;
  let tailStart = 0;
  let tailChars = 0;
  return {
    push(line: string): void {
      if (head.length < limits.headLines) {
        head.push(line);
        tailStart = head.length;
        return;
      }
      tail.push(line);
      tailChars += line.length;
      while (tailChars > limits.tailChars && tail.length - offset > 1) {
        tailChars -= tail[offset]?.length ?? 0;
        offset += 1;
        tailStart += 1;
      }
      if (offset > 1024 && offset * 2 > tail.length) {
        tail = tail.slice(offset);
        offset = 0;
      }
    },
    /** The line numbered `index`, or the next kept one after it; `null` when there is none yet. */
    from(index: number): { readonly index: number; readonly line: string } | null {
      const line = head[index];
      if (line !== undefined) return { index, line };
      const at = Math.max(index, tailStart);
      const kept = tail[offset + at - tailStart];
      return kept === undefined ? null : { index: at, line: kept };
    },
    all: (): string[] => [...head, ...tail.slice(offset)],
  };
};

/**
 * Splits a stream into lines (`\n`, a trailing `\r` dropped), each cut to `maxChars`, so one
 * endless line cannot grow without bound. The last line is passed on even without a newline.
 * `close()` stops reading and passes on what is buffered.
 */
const readLines = (
  stream: NodeJS.ReadableStream,
  maxChars: number,
  onLine: (line: string) => void,
  onClose: () => void,
) => {
  let partial = "";
  let cut = false;
  let closed = false;
  const flush = (): void => {
    const line = !cut && partial.endsWith("\r") ? partial.slice(0, -1) : partial;
    partial = "";
    cut = false;
    onLine(line);
  };
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (closed) return;
    let start = 0;
    for (;;) {
      const newline = chunk.indexOf("\n", start);
      if (!cut) {
        partial += newline === -1 ? chunk.slice(start) : chunk.slice(start, newline);
        if (partial.length > maxChars) {
          partial = partial.slice(0, maxChars);
          cut = true;
        }
      }
      if (newline === -1) return;
      flush();
      start = newline + 1;
    }
  });
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (partial !== "" || cut) flush();
    onClose();
  };
  stream.once("end", close);
  stream.once("close", close);
  return { close };
};

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
  /** How much stdout is kept. Default {@link TRANSCRIPT_LIMITS}. */
  readonly transcriptLimits?: TranscriptLimits;
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
  const transcript = createTranscript(options.transcriptLimits ?? TRANSCRIPT_LIMITS);
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

  let stdoutClosed: () => void = () => undefined;
  const stdoutDone = new Promise<void>((resolve) => {
    stdoutClosed = resolve;
  });
  const reader = readLines(
    child.stdout,
    (options.transcriptLimits ?? TRANSCRIPT_LIMITS).lineChars,
    (line) => {
      transcript.push(line);
      armIdle();
      wake();
    },
    () => {
      state.stdoutDone = true;
      stdoutClosed();
    },
  );
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
        stdoutDone,
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
    return options.outcome(transcript.all(), { ...exit, stderrTail, endedAt, stop: state.stop });
  })();

  return {
    command: options.command,
    pid: child.pid,
    async *lines() {
      let index = 0;
      for (;;) {
        for (let next = transcript.from(index); next !== null; next = transcript.from(index)) {
          index = next.index + 1;
          yield next.line;
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
