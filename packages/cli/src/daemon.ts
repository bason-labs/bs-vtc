/**
 * Finding and starting the repo's engine daemon (AD-12). The daemon publishes
 * `~/.vtc/engines/<repo-key>.json`; a record whose pid is gone is stale. When none is live,
 * `vtc engine --mcp` and the control commands start `vtc engine --daemon` detached (not a child
 * of any host session, so it outlives it) and wait for its discovery record.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { core } from "@vtc/engine";
import { engineRepoKey, type EngineDiscovery } from "@vtc/shared";

/** True when a process with this pid exists (signal 0 only checks; EPERM means it exists). */
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The repo's discovery record when its daemon process is alive, else `null`. */
export const liveDaemon = (vtcHome: string, repoRoot: string): EngineDiscovery | null => {
  const record = core.readEngineDiscovery(vtcHome, repoRoot);
  return record !== null && pidAlive(record.pid) ? record : null;
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

/** The live daemon for the repo, starting one when there is none. */
export const ensureDaemon = async (options: EnsureDaemonOptions): Promise<EngineDiscovery> => {
  const live = liveDaemon(options.vtcHome, options.repoRoot);
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
    const started = liveDaemon(options.vtcHome, options.repoRoot);
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
