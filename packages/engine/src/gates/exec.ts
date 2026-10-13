/**
 * Runs one gate command: argv without a shell (commands are data, `GateSchema.command`), a hard
 * timeout that kills the whole process group, a scrubbed environment (no tokens or credentials
 * from the engine's own environment reach a gate), and stdout/stderr streamed to raw log files
 * under `.vtc/state/` (§7.2: raw output stays gitignored).
 *
 * The Gate Runner never calls {@link runCommand} directly for a gate: every command goes through
 * the gate sandbox (`sandbox.ts` `GateCommandJail`, D-al), which wraps the argv in `sandbox-exec`
 * or `bwrap` and points `HOME` and the temp variables at private per-run directories.
 */
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Variables a toolchain needs to start; everything else of the engine's environment is dropped. */
export const PASSED_ENV: readonly string[] = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "TZ",
  "PNPM_HOME",
  "NVM_DIR",
  "VOLTA_HOME",
  "BUN_INSTALL",
  "GOPATH",
  "GOROOT",
  "GOCACHE",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "JAVA_HOME",
  "SystemRoot",
  "SYSTEMROOT",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "ProgramData",
  "ProgramFiles",
];

/** The environment a gate runs with: the passed variables plus non-interactive defaults. */
export const gateEnv = (
  source: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return { ...env, CI: "1", NO_COLOR: "1", FORCE_COLOR: "0", ...extra };
};

export interface ExecRequest {
  readonly argv: readonly string[];
  /** Absolute working directory. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  /** Absolute paths of the raw logs (created with their directories). */
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /**
   * The command runs under the macOS sandbox's reaper (`sandbox.ts` `REAPER_SCRIPT`): stdin is
   * the control pipe, closed as soon as the command's process exits or times out, and fd 3 is a
   * pipe on which the reaper confirms (`R`) before it kills everything left in the sandbox. The
   * result waits until fd 3 closes, i.e. until the reaper and everything it killed are gone.
   */
  readonly reaper?: boolean;
}

export interface ExecResult {
  /** Exit code, or `null` when killed by a signal or never started. */
  readonly code: number | null;
  readonly timedOut: boolean;
  /** Set when the process could not be started (e.g. `ENOENT`). */
  readonly spawnError?: string;
  readonly durationMs: number;
  /** The last bytes of stdout and stderr, for failure classification (raw, never written to git). */
  readonly tail: string;
  /** With `reaper`: whether the reaper confirmed that it stopped what the command left behind. */
  readonly reaped?: boolean;
}

const TAIL_BYTES = 64 * 1024;
const KILL_GRACE_MS = 2_000;
/** How long a result waits for the reaper after the command ended (it normally takes ms). */
const REAPER_WAIT_MS = 10_000;

export const runCommand = (request: ExecRequest): Promise<ExecResult> => {
  const started = Date.now();
  const [command, ...args] = request.argv;
  mkdirSync(dirname(request.stdoutPath), { recursive: true });
  mkdirSync(dirname(request.stderrPath), { recursive: true });
  const out = createWriteStream(request.stdoutPath);
  const err = createWriteStream(request.stderrPath);
  let tail = "";
  const keep = (chunk: Buffer): void => {
    tail = (tail + chunk.toString("utf8")).slice(-TAIL_BYTES);
  };
  const closeLogs = (): Promise<void> =>
    Promise.all([
      new Promise<void>((resolve) => out.end(resolve)),
      new Promise<void>((resolve) => err.end(resolve)),
    ]).then(() => undefined);

  return new Promise<ExecResult>((resolve) => {
    if (command === undefined) {
      void closeLogs().then(() => {
        resolve({ code: null, timedOut: false, spawnError: "empty command", durationMs: 0, tail });
      });
      return;
    }
    const windows = process.platform === "win32";
    const reaper = request.reaper === true;
    const child = spawn(command, args, {
      cwd: request.cwd,
      env: request.env,
      shell: false,
      detached: !windows,
      stdio: reaper ? ["pipe", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let confirmation = "";
    let releasedAt: number | null = null;
    // Closing the control pipe tells the reaper the command has ended.
    const release = (): void => {
      releasedAt ??= Date.now();
      child.stdin?.destroy();
    };
    // Settles once the reaper's pipe closes: the reaper, and everything it killed, are gone. Bun
    // emits `close` for the child before its extra pipes close, so this is awaited explicitly.
    let reaperGone: Promise<void> = Promise.resolve();
    if (reaper) {
      child.stdin?.on("error", () => undefined);
      const confirm = child.stdio[3];
      if (confirm !== undefined && confirm !== null && "on" in confirm) {
        reaperGone = new Promise<void>((done) => {
          confirm.on("close", () => {
            done();
          });
          confirm.on("error", () => {
            done();
          });
        });
        confirm.on("data", (chunk: Buffer) => {
          confirmation = (confirmation + chunk.toString("utf8")).slice(-16);
        });
      }
      child.on("exit", release);
    }
    /** The reaper's pipe closing, but never longer than {@link REAPER_WAIT_MS} after release. */
    const awaitReaper = (): Promise<void> =>
      Promise.race([
        reaperGone,
        new Promise<void>((done) => {
          const left = REAPER_WAIT_MS - (Date.now() - (releasedAt ?? Date.now()));
          setTimeout(done, Math.max(0, left)).unref();
        }),
      ]);
    const killTree = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        if (windows) child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      setTimeout(() => {
        killTree("SIGKILL");
        if (reaper) release();
      }, KILL_GRACE_MS).unref();
    }, request.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      out.write(chunk);
      keep(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      err.write(chunk);
      keep(chunk);
    });
    const finish = (code: number | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Reap anything the command left behind in its process group (§15: no orphans).
      if (!windows) killTree("SIGKILL");
      if (reaper) release();
      void Promise.all([closeLogs(), awaitReaper()]).then(() => {
        resolve({
          code,
          timedOut,
          durationMs: Date.now() - started,
          tail,
          ...(spawnError === undefined ? {} : { spawnError }),
          ...(reaper ? { reaped: confirmation.includes("R") } : {}),
        });
      });
    };
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(null, error.code ?? error.message);
    });
    child.on("close", (code) => {
      finish(code);
    });
  });
};
