/**
 * The process seam (§15 hardened launcher). Adapters start host processes only through a
 * {@link Spawner}, so tests inject a fake one and never run a real host binary. The Node spawner
 * starts each child as the leader of its own process group, so `kill` reaches the whole tree
 * (tools and MCP servers the host started), and once the leader has exited it kills whatever is
 * left in the group, leaving no orphans.
 *
 * Known gap (Windows, spec §4.4 windows-x64): without a shell, `spawn` cannot start npm `.cmd`
 * shims, and `child.kill` does not reach the process tree. When Windows support lands, resolve the
 * executable through PATHEXT (still without a shell) and kill trees with a job object or
 * `taskkill /T /F` (see the `it.todo` in headless-run.test.ts).
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

/** How long stdout and stderr may stay open after the leader exited before they are cut. */
const DEFAULT_DRAIN_MS = 2000;

export interface NodeSpawnerOptions {
  /**
   * After the leader exits, how long to wait for its stdio to close. A process that left the
   * group (setsid, a daemonising tool) can hold the pipes forever; after this the pipes are cut
   * and the process counts as exited.
   */
  readonly drainMs?: number;
}

/** Starts real host processes. The child inherits the user's environment plus `command.env`. */
export const createNodeSpawner =
  (spawnerOptions: NodeSpawnerOptions = {}): Spawner =>
  (command, options) => {
    const child = spawn(command.command, [...command.args], {
      cwd: options.cwd,
      env: { ...process.env, ...command.env },
      stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      detached: POSIX,
      windowsHide: true,
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) throw new Error("stdout and stderr are always piped");
    const pid = child.pid;
    const signalGroup = (signal: "SIGTERM" | "SIGKILL"): void => {
      if (pid === undefined) return;
      try {
        if (POSIX) process.kill(-pid, signal);
        else child.kill(signal);
      } catch {
        // the group is gone already
      }
    };
    let settled = false;
    const exited = new Promise<ProcessExit>((resolve) => {
      const finish = (exit: ProcessExit): void => {
        if (settled) return;
        settled = true;
        // no orphans (§15): whatever the leader left running in its group goes with it
        if (exit.error === null) signalGroup("SIGKILL");
        resolve(exit);
      };
      child.once("error", (error) => {
        finish({ code: null, signal: null, error });
      });
      let drain: NodeJS.Timeout | undefined;
      child.once("exit", (code, signal) => {
        drain = setTimeout(() => {
          stdout.destroy();
          stderr.destroy();
          finish({ code, signal, error: null });
        }, spawnerOptions.drainMs ?? DEFAULT_DRAIN_MS);
      });
      child.once("close", (code, signal) => {
        clearTimeout(drain);
        finish({ code, signal, error: null });
      });
    });
    return {
      pid: pid ?? null,
      stdout,
      stderr,
      stdin: child.stdin,
      exited,
      kill: (signal) => {
        // the group outlives its leader while a tool it started still runs, so signal it until
        // the process has settled (settling kills the rest of the group itself)
        if (!settled) signalGroup(signal);
      },
    };
  };

export const nodeSpawner: Spawner = createNodeSpawner();
