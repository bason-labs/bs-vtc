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
import nodePath, { type PlatformPath } from "node:path";
import type { Readable, Writable } from "node:stream";
import { findForbiddenHostArgs, type HostCommand } from "@vtc/shared";

/** The signals the launcher sends, in this order when it stops a run (AD-25 rule 4). */
export type ProcessSignal = "SIGINT" | "SIGTERM" | "SIGKILL";

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
  /** Signals the process and everything it started (its process group). Safe after exit. */
  kill(signal: ProcessSignal): void;
}

export interface SpawnOptions {
  /** Absolute working directory. */
  readonly cwd: string;
  /** `closed`: stdin is /dev/null (`codex exec` waits on an open stdin, spike 1). */
  readonly stdin: "closed" | "pipe";
}

export type Spawner = (command: HostCommand, options: SpawnOptions) => SpawnedProcess;

const POSIX = process.platform !== "win32";

/**
 * The variables a host child inherits from VTC's own environment (AD-25 rule 4): an allowlist, so
 * no credential variable (AD-9), no `NODE_OPTIONS`, no `GIT_*` location and no agent socket
 * reaches a role run. The real `HOME` (and the hosts' own config locations) stay, so the host
 * finds the user's login itself; VTC never reads it. Matched case-insensitively (Windows names
 * are), so `https_proxy` passes with `HTTPS_PROXY`. `PATH` passes with its absolute entries only
 * ({@link absoluteSearchPath}).
 */
const INHERITED_ENV: ReadonlySet<string> = new Set([
  // the user and the shell basics
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TERM",
  "TMPDIR",
  // where the hosts keep their config and login (paths only), and the VTC home the role's engine
  // bridge needs to find the daemon
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "VTC_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  // reaching the host's API through the user's network
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows essentials
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "TEMP",
  "TMP",
]);

const inherited = (name: string): boolean => {
  const upper = name.toUpperCase();
  return INHERITED_ENV.has(upper) || upper.startsWith("LC_");
};

/**
 * Pure: `PATH` with only its absolute entries. An empty entry, `.` or any relative entry is
 * searched from the child's working directory (a role's worktree, where a role can plant a
 * `node_modules/.bin/claude` or `vtc`), so a host binary or the engine bridge the host starts
 * outside the role sandbox could be the role's own file. Those entries are dropped (§15, AD-9).
 */
export const absoluteSearchPath = (value: string, path: PlatformPath = nodePath): string =>
  value
    .split(path.delimiter)
    .filter((entry) => entry !== "" && path.isAbsolute(entry))
    .join(path.delimiter);

/**
 * A name from `~/.vtc/config.yaml` `env_passthrough` (D-ak, spine §5 reading 57) that may reach a
 * host child: never a host credential variable (AD-9 markers: a headless run never switches the
 * host to API-key mode, AD-25 rule 2) and never `PATH`, whose entries are always filtered.
 */
const passable = (name: string): boolean =>
  name.toUpperCase() !== "PATH" && findForbiddenHostArgs([name]).length === 0;

/**
 * Pure: a host child's environment, the allowlisted part of `parent`, the names the user listed
 * in `env_passthrough` (`passthrough`, minus host credential variables), plus the command's own
 * variables (`HostCommand.env`, which the safety contract checks). `PATH` keeps only its absolute
 * entries ({@link absoluteSearchPath}).
 */
export const childEnvironment = (
  parent: Readonly<Record<string, string | undefined>>,
  added: Readonly<Record<string, string>>,
  passthrough: readonly string[] = [],
): Record<string, string> => {
  const listed = new Set(passthrough.filter(passable));
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(parent)) {
    if (value !== undefined && (inherited(name) || listed.has(name))) env[name] = value;
  }
  const merged: Record<string, string> = { ...env, ...added };
  for (const name of Object.keys(merged)) {
    const value = merged[name];
    if (name.toUpperCase() === "PATH" && value !== undefined) {
      merged[name] = absoluteSearchPath(value);
    }
  }
  return merged;
};

/** How long stdout and stderr may stay open after the leader exited before they are cut. */
const DEFAULT_DRAIN_MS = 2000;

export interface NodeSpawnerOptions {
  /**
   * After the leader exits, how long to wait for its stdio to close. A process that left the
   * group (setsid, a daemonising tool) can hold the pipes forever; after this the pipes are cut
   * and the process counts as exited.
   */
  readonly drainMs?: number;
  /**
   * Variable names the user listed in `~/.vtc/config.yaml` `env_passthrough` (D-ak, spine §5
   * reading 57), which pass to host children besides the allowlist. Host credential variables
   * never pass ({@link childEnvironment}). Default: none.
   */
  readonly envPassthrough?: readonly string[];
}

/**
 * Starts real host processes, each the leader of its own process group. The child gets
 * {@link childEnvironment}: the allowlisted part of the user's environment (with an absolute-only
 * `PATH`), the `envPassthrough` names, plus `command.env`.
 */
export const createNodeSpawner =
  (spawnerOptions: NodeSpawnerOptions = {}): Spawner =>
  (command, options) => {
    const child = spawn(command.command, [...command.args], {
      cwd: options.cwd,
      env: childEnvironment(process.env, command.env, spawnerOptions.envPassthrough),
      stdio: [options.stdin === "pipe" ? "pipe" : "ignore", "pipe", "pipe"],
      detached: POSIX,
      windowsHide: true,
    });
    const { stdout, stderr } = child;
    if (stdout === null || stderr === null) throw new Error("stdout and stderr are always piped");
    const pid = child.pid;
    const signalGroup = (signal: ProcessSignal): void => {
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
