/**
 * Finding and starting the repo's engine daemon (AD-12). The daemon publishes
 * `~/.vtc/engines/<repo-key>.json`. A record counts as live only when a daemon answers on its
 * `mcp_socket` (AD-12 rule 3: the hello/welcome exchange); a pid that still exists is not enough,
 * since pids are reused after a crash or a reboot. When none answers, `vtc engine --mcp` and the
 * control commands start `vtc engine --daemon` detached (not a child of any host session, so it
 * outlives it) and wait for its discovery record. Nothing sends the install token to a record's
 * HTTP port before its socket answered (AD-5): the socket sits in the 0700 run directory.
 * Nothing starts a daemon in a repo `vtc init` never set up (`requireVtcProject`), and a daemon
 * that answers but refuses this `vtc` (a different contracts MAJOR) is reported with how to stop
 * it (`vtc engine --stop`), never counted live.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { core } from "@vtc/engine";
import {
  CONTRACTS_VERSION,
  encodeSocketLine,
  engineRepoKey,
  ENGINE_INSTANCE,
  EngineSocketWelcomeSchema,
  type EngineDiscovery,
  type EngineSocketWelcome,
} from "@vtc/shared";
import { requireVtcProject } from "./repo.js";
import { passthroughOf, readUserConfig, researchKeyNamesOf } from "./user-config.js";

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
 * The `EngineSocketWelcome` a VTC daemon answers on `socketPath` to a `client: cli` hello, or
 * `null` when nothing well-formed answers (no socket, something else listening, a timeout). An
 * `ok: false` refusal (e.g. a different contracts MAJOR after an upgrade) is returned as is: it
 * proves a daemon is there, one this `vtc` cannot use. The connection is closed right after; no
 * MCP traffic is sent.
 */
export const probeDaemon = (
  socketPath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<EngineSocketWelcome | null> =>
  new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = connect(socketPath);
    const finish = (welcome: EngineSocketWelcome | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(welcome);
    };
    const timer = setTimeout(() => {
      finish(null);
    }, timeoutMs);
    socket.on("error", () => {
      finish(null);
    });
    socket.on("close", () => {
      finish(null);
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
        if (buffer.length > MAX_WELCOME_BYTES) finish(null);
        return;
      }
      try {
        const raw: unknown = JSON.parse(buffer.subarray(0, at).toString("utf8"));
        const parsed = EngineSocketWelcomeSchema.safeParse(raw);
        finish(parsed.success ? parsed.data : null);
      } catch {
        finish(null);
      }
    });
  });

/** True when a VTC daemon answers on `socketPath` at all, a refusal included. */
export const daemonAnswers = async (
  socketPath: string,
  timeoutMs = PROBE_TIMEOUT_MS,
): Promise<boolean> => (await probeDaemon(socketPath, timeoutMs)) !== null;

/** How {@link daemonState} checks a record: its daemon's welcome, or `null`. Tests inject one. */
export type DaemonProbe = (record: EngineDiscovery) => Promise<EngineSocketWelcome | null>;

const welcomeOf: DaemonProbe = (record) =>
  pidAlive(record.pid) ? probeDaemon(record.mcp_socket) : Promise.resolve(null);

/**
 * The repo's daemon as this `vtc` sees it: `live` (it answered and accepts this client),
 * `refused` (it answered `ok: false`: a daemon of an incompatible `vtc` still runs) or `absent`
 * (no record, or a stale one nothing answers for).
 */
export type DaemonState =
  | { readonly state: "live"; readonly record: EngineDiscovery }
  | { readonly state: "refused"; readonly record: EngineDiscovery; readonly error: string }
  | { readonly state: "absent" };

export const daemonState = async (
  vtcHome: string,
  repoRoot: string,
  probe: DaemonProbe = welcomeOf,
): Promise<DaemonState> => {
  const record = core.readEngineDiscovery(vtcHome, repoRoot);
  if (record === null) return { state: "absent" };
  const welcome = await probe(record);
  if (welcome === null) return { state: "absent" };
  return welcome.ok
    ? { state: "live", record }
    : { state: "refused", record, error: welcome.error ?? "unknown error" };
};

/** The repo's discovery record when its daemon answers and accepts this `vtc`, else `null`. */
export const liveDaemon = async (
  vtcHome: string,
  repoRoot: string,
  probe: DaemonProbe = welcomeOf,
): Promise<EngineDiscovery | null> => {
  const found = await daemonState(vtcHome, repoRoot, probe);
  return found.state === "live" ? found.record : null;
};

/** What to tell the user about a daemon that refused this `vtc`. */
export const refusedMessage = (repoRoot: string, pid: number, error: string): string =>
  `the engine running for ${repoRoot} (pid ${String(pid)}) refused this vtc (${error}); it is most likely from an older or newer vtc. Stop it with \`vtc engine --stop\` in that repo and try again`;

/** A daemon of an incompatible `vtc` holds the repo. */
export class IncompatibleDaemonError extends Error {
  constructor(repoRoot: string, pid: number, error: string) {
    super(refusedMessage(repoRoot, pid, error));
    this.name = "IncompatibleDaemonError";
  }
}

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

/**
 * Variables the detached daemon keeps from the environment of whoever started it. The daemon is
 * shared by every later session of either host, so it does not inherit one session's whole
 * environment (`CLAUDECODE`, a host's entrypoint markers, secrets the user exported): only what
 * the runtime, git, gh and the host CLIs need to find the user's own installation, configuration,
 * proxies and locale. Credentials stay with the hosts' own logins (AD-9), except the names the
 * user lists in `~/.vtc/config.yaml` `env_passthrough` (D-ak, never the repo's project.yaml).
 */
const DAEMON_ENV = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SSH_AUTH_SOCK",
  "GNUPGHOME",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GH_CONFIG_DIR",
  "GH_HOST",
  "CLAUDE_CONFIG_DIR",
  "CODEX_HOME",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  // Windows
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "PROGRAMDATA",
  "PROGRAMFILES",
]);

/** `LC_*` and `XDG_*`: locale and the XDG base directories. */
const DAEMON_ENV_PREFIXES = ["LC_", "XDG_"];

/**
 * The detached daemon's environment: {@link DAEMON_ENV} from `env`, the names the user lists in
 * `~/.vtc/config.yaml` `env_passthrough` (D-ak, `user-config.ts`; credential variables are
 * dropped otherwise, AD-9), plus `VTC_HOME`.
 */
export const daemonEnv = (
  env: Readonly<Record<string, string | undefined>>,
  vtcHome: string,
  passthrough: readonly string[] = [],
): Record<string, string> => {
  const fold = (name: string): string => (process.platform === "win32" ? name.toUpperCase() : name);
  const extra = new Set(passthrough.map(fold));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const key = fold(name);
    if (DAEMON_ENV.has(key) || extra.has(key) || DAEMON_ENV_PREFIXES.some((p) => key.startsWith(p)))
      out[name] = value;
  }
  return { ...out, VTC_HOME: vtcHome };
};

/** Starts `vtc engine --daemon` detached in `repoRoot`, logging to {@link daemonLogPath}. */
export const spawnDetachedDaemon = (options: EnsureDaemonOptions): ChildProcess => {
  const [command, ...prefix] = options.selfCommand;
  if (command === undefined) throw new Error("no command to start the daemon with");
  const log = daemonLogPath(options.vtcHome, options.repoRoot);
  mkdirSync(join(options.vtcHome, "logs"), { recursive: true, mode: 0o700 });
  const fd = openSync(log, "a", 0o600);
  try {
    const config = readUserConfig(options.vtcHome);
    if (!config.ok)
      writeSync(
        fd,
        `${new Date().toISOString()} vtc: ${config.path} does not parse (${config.error}); no env_passthrough names pass\n`,
      );
    const child = spawn(command, [...prefix, "engine", "--daemon", ...(options.flags ?? [])], {
      cwd: options.repoRoot,
      detached: true,
      stdio: ["ignore", fd, fd],
      // the research fetchers' key variables too (reading 120): the daemon reads them at call
      // time; they never reach a host child (the adapters get `env_passthrough` only)
      env: daemonEnv(process.env, options.vtcHome, [
        ...passthroughOf(config),
        ...Object.values(researchKeyNamesOf(config)),
      ]),
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

/** The pid recorded in the repo's engine lock (`.vtc/state/engine.lock`), or `null`. */
export const lockHolder = (repoRoot: string): number | null => {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(repoRoot, ENGINE_INSTANCE.lockFile), "utf8"));
    const pid = typeof raw === "object" && raw !== null ? (raw as { pid?: unknown }).pid : null;
    return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

/** How long after the spawned daemon exited a winner's discovery may take when no lock is held. */
const EXIT_GRACE_MS = 2_000;

/**
 * The live daemon for the repo, starting one when none answers. A stale record (its daemon died
 * without cleaning up) is left to the new daemon, which takes over the stale lock and rewrites it.
 * Refuses a repo `vtc init` never set up, and a repo held by a daemon that refuses this `vtc`.
 */
export const ensureDaemon = async (options: EnsureDaemonOptions): Promise<EngineDiscovery> => {
  requireVtcProject(options.repoRoot);
  const settled = (found: DaemonState): EngineDiscovery | null => {
    if (found.state === "refused")
      throw new IncompatibleDaemonError(options.repoRoot, found.record.pid, found.error);
    return found.state === "live" ? found.record : null;
  };
  const live = settled(await daemonState(options.vtcHome, options.repoRoot));
  if (live !== null) return live;
  const child = spawnDetachedDaemon(options);
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  // A daemon that exits early either lost the lock to a concurrent start (or to a daemon too busy
  // to answer the probe in time) or failed. While the lock's holder is alive, its discovery is
  // coming: keep probing until the full timeout. With no live holder, report the failure soon.
  const exit: { at: number | null } = { at: null };
  const ended = (): void => {
    exit.at ??= Date.now();
  };
  child.once("exit", ended);
  child.once("error", ended);
  while (Date.now() < deadline) {
    await sleep(100);
    const started = settled(await daemonState(options.vtcHome, options.repoRoot));
    if (started !== null) return started;
    if (exit.at !== null && Date.now() - exit.at > EXIT_GRACE_MS) {
      const holder = lockHolder(options.repoRoot);
      if (holder === null || holder === child.pid || !pidAlive(holder)) break;
    }
  }
  const log = daemonLogPath(options.vtcHome, options.repoRoot);
  throw new Error(`the engine did not start for ${options.repoRoot}${logTail(log)} (log: ${log})`);
};

/**
 * `vtc engine --stop`: sends SIGTERM to the repo's daemon (the pid of its discovery record, only
 * once its socket answered, so a reused pid is never signalled) and waits for it to exit.
 * Resolves the stopped pid, or `null` when no daemon answers.
 */
export const stopDaemon = async (
  vtcHome: string,
  repoRoot: string,
  timeoutMs = 10_000,
): Promise<number | null> => {
  const found = await daemonState(vtcHome, repoRoot);
  if (found.state === "absent") return null;
  const { pid } = found.record;
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return pid;
    throw error;
  }
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() > deadline)
      throw new Error(
        `the engine (pid ${String(pid)}) did not exit within ${String(timeoutMs)} ms`,
      );
    await sleep(100);
  }
  return pid;
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
