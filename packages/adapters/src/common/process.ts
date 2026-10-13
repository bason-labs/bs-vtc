/**
 * The process seam (§15 hardened launcher). Adapters start host processes only through a
 * {@link Spawner}, so tests inject a fake one and never run a real host binary. The Node spawner
 * starts each child as the leader of its own process group, so `kill` reaches the whole tree
 * (tools and MCP servers the host started), leaving no orphans.
 */
import { spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { HostCommand } from "@vtc/shared";

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
  /** Set when the process could not be started (e.g. the host binary is not on PATH). */
  readonly error: Error | null;
}

export interface SpawnedProcess {
  readonly pid: number | null;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** `null` when stdin is closed (`stdin: "closed"`). */
  readonly stdin: Writable | null;
  /** Resolves once, when the process has exited or failed to start. Never rejects. */
  readonly exited: Promise<ProcessExit>;
  /** Signals the process and everything it started. Safe after exit. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface SpawnOptions {
  /** Absolute working directory. */
  readonly cwd: string;
  /** `closed`: stdin is /dev/null (`codex exec` waits on an open stdin, spike 1). */
  readonly stdin: "closed" | "pipe";
}

export type Spawner = (command: HostCommand, options: SpawnOptions) => SpawnedProcess;

const POSIX = process.platform !== "win32";

/** Starts real host processes. The child inherits the user's environment plus `command.env`. */
export const nodeSpawner: Spawner = (command, options) => {
  const child = spawn(command.command, [...command.args], {
    cwd: options.cwd,
    env: { ...process.env, ...command.env },
    stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
    detached: POSIX,
    windowsHide: true,
  });
  const { stdout, stderr } = child;
  if (stdout === null || stderr === null) throw new Error("stdout and stderr are always piped");
  let settled = false;
  const exited = new Promise<ProcessExit>((resolve) => {
    child.once("error", (error) => {
      settled = true;
      resolve({ code: null, signal: null, error });
    });
    child.once("close", (code, signal) => {
      settled = true;
      resolve({ code, signal, error: null });
    });
  });
  return {
    pid: child.pid ?? null,
    stdout,
    stderr,
    stdin: child.stdin,
    exited,
    kill: (signal) => {
      // the group outlives its leader while a tool it started still runs, so signal it until
      // stdio closes
      if (child.pid === undefined || settled) return;
      try {
        if (POSIX) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch {
        // the group is gone already
      }
    },
  };
};
