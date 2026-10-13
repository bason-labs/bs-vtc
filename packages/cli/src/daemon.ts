/**
 * Finding and starting the repo's engine daemon (AD-12). The daemon publishes
 * `~/.vtc/engines/<repo-key>.json`. A record counts as live only when a daemon answers on its
 * `mcp_socket` (AD-12 rule 3: the hello/welcome exchange); a pid that still exists is not enough,
 * since pids are reused after a crash or a reboot. When none answers, `vtc engine --mcp` and the
 * control commands start `vtc engine --daemon` detached (not a child of any host session, so it
 * outlives it) and wait for its discovery record. Nothing sends the install token to a record's
 * HTTP port before its socket answered (AD-5): the socket sits in the 0700 run directory.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { core } from "@vtc/engine";
import {
  CONTRACTS_VERSION,
  encodeSocketLine,
  engineRepoKey,
  EngineSocketWelcomeSchema,
  type EngineDiscovery,
} from "@vtc/shared";

/** True when a process with this pid exists (signal 0 only checks; EPERM means it exists). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** How long a liveness probe waits for the daemon's welcome line. */
export const PROBE_TIMEOUT_MS = 1_500;

/** The welcome line is small; anything longer is not a daemon answering. */
const MAX_WELCOME_BYTES = 4 * 1024;

/**
 * True when a VTC daemon answers on `socketPath`: it accepts a `client: cli` hello and replies
 * with a well-formed `EngineSocketWelcome` line (an `ok: false` refusal still proves a daemon is
 * there). The connection is closed right after; no MCP traffic is sent.
 */
export const daemonAnswers = (socketPath: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = connect(socketPath);
    const finish = (answered: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => {
      finish(false);
    }, timeoutMs);
    socket.on("error", () => {
      finish(false);
    });
    socket.on("close", () => {
      finish(false);
    });
    socket.once("connect", () => {
      socket.write(
        encodeSocketLine({ v: 1, client: "cli", host: null, contracts_version: CONTRACTS_VERSION }),
      );
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf(0x0a);
      if (at < 0) {
        if (buffer.length > MAX_WELCOME_BYTES) finish(false);
        return;
      }
      try {
        const raw: unknown = JSON.parse(buffer.subarray(0, at).toString("utf8"));
        finish(EngineSocketWelcomeSchema.safeParse(raw).success);
      } catch {
        finish(false);
      }
    });
  });

/** How {@link liveDaemon} checks a record; tests inject their own. */
export type DaemonProbe = (record: EngineDiscovery) => Promise<boolean>;

const answers: DaemonProbe = (record) =>
  pidAlive(record.pid) ? daemonAnswers(record.mcp_socket) : Promise.resolve(false);

/** The repo's discovery record when its daemon answers on its socket, else `null` (stale). */
export const liveDaemon = async (
  vtcHome: string,
  repoRoot: string,
  probe: DaemonProbe = answers,
): Promise<EngineDiscovery | null> => {
  const record = core.readEngineDiscovery(vtcHome, repoRoot);
  return record !== null && (await probe(record)) ? record : null;
};

/** `~/.vtc/logs/engine-<repo-key>.log`: where a detached daemon's stdout and stderr go. */
export const daemonLogPath = (vtcHome: string, repoRoot: string): string =>
  join(vtcHome, "logs", `engine-${engineRepoKey(repoRoot)}.log`);

export interface EnsureDaemonOptions {
  readonly vtcHome: string;
  readonly repoRoot: string;
  /** argv prefix that runs `vtc` (`CliRuntime.selfCommand`). */
  readonly selfCommand: readonly string[];
  /** Extra daemon flags, e.g. `--wake`. */
  readonly flags?: readonly string[];
  readonly timeoutMs?: number;
}

/** Starts `vtc engine --daemon` detached in `repoRoot`, logging to {@link daemonLogPath}. */
export const spawnDetachedDaemon = (options: EnsureDaemonOptions): ChildProcess => {
  const [command, ...prefix] = options.selfCommand;
  if (command === undefined) throw new Error("no command to start the daemon with");
  const log = daemonLogPath(options.vtcHome, options.repoRoot);
  mkdirSync(join(options.vtcHome, "logs"), { recursive: true, mode: 0o700 });
  const fd = openSync(log, "a", 0o600);
  try {
    const child = spawn(command, [...prefix, "engine", "--daemon", ...(options.flags ?? [])], {
      cwd: options.repoRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, VTC_HOME: options.vtcHome },
      windowsHide: true,
    });
    child.on("error", () => undefined);
    child.unref();
    return child;
  } finally {
    closeSync(fd);
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The live daemon for the repo, starting one when none answers. A stale record (its daemon died
 * without cleaning up) is left to the new daemon, which takes over the stale lock and rewrites it.
 */
export const ensureDaemon = async (options: EnsureDaemonOptions): Promise<EngineDiscovery> => {
  const live = await liveDaemon(options.vtcHome, options.repoRoot);
  if (live !== null) return live;
  const child = spawnDetachedDaemon(options);
  let deadline = Date.now() + (options.timeoutMs ?? 20_000);
  // A daemon that exits early either lost the lock to a concurrent start (whose discovery
  // appears shortly) or failed: wait a little for the former, then report the latter.
  const ended = (): void => {
    deadline = Math.min(deadline, Date.now() + 2_000);
  };
  child.once("exit", ended);
  child.once("error", ended);
  while (Date.now() < deadline) {
    await sleep(100);
    const started = await liveDaemon(options.vtcHome, options.repoRoot);
    if (started !== null) return started;
  }
  const log = daemonLogPath(options.vtcHome, options.repoRoot);
  throw new Error(`the engine did not start for ${options.repoRoot}${logTail(log)} (log: ${log})`);
};

/** The last lines of the daemon log, for an error message. */
const logTail = (path: string): string => {
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/).slice(-3);
    return lines.length === 0 || lines[0] === "" ? "" : `: ${lines.join(" | ")}`;
  } catch {
    return "";
  }
};
