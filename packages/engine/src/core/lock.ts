/**
 * Single-writer lock (AD-12): one engine per repo. The holder is the only process allowed to
 * append to `.vtc/runs/<run>/events.jsonl` (AD-7 rule 2). Exclusive create (`wx`) is atomic on
 * every local filesystem both runtimes support.
 *
 * A lock is stale when its holder is gone (AD-12 rule 1, spine §5 reading 67): its pid is dead,
 * or, since a pid can be reused after a `SIGKILL` or a reboot, the holder's MCP socket (recorded
 * in the lock) does not answer the hello. {@link acquireEngineLock} decides on the pid alone (it
 * is synchronous); {@link takeEngineLock}, which the daemon uses, also asks the socket, several
 * times with backoff, so a live engine whose event loop is briefly busy is never taken over.
 */
import { closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENGINE_INSTANCE } from "@vtc/shared";

export class EngineLockedError extends Error {
  constructor(
    readonly lockPath: string,
    readonly holderPid: number | null,
  ) {
    super(
      `another VTC engine holds ${lockPath}${holderPid === null ? "" : ` (pid ${String(holderPid)})`}`,
    );
    this.name = "EngineLockedError";
  }
}

export interface EngineLock {
  readonly path: string;
  readonly pid: number;
  /** True while this lock file still exists and names this holder. */
  isHeld(): boolean;
  /** Removes the lock if this holder still owns it. Idempotent. */
  release(): void;
}

/** What a lock file says about its holder (`null` fields: an older or unreadable lock). */
export interface LockHolder {
  readonly pid: number | null;
  readonly acquiredAt: string | null;
  /** The holder's local MCP socket (or Windows pipe), which answers the hello while it lives. */
  readonly socket: string | null;
  /** The lock file's bytes: a takeover removes only the exact lock it judged stale. */
  readonly raw: string;
}

/** Why a lock was taken over: its pid is dead, or its pid lives but its socket is silent. */
export type StaleLockReason = "dead" | "silent";

export interface AcquireLockOptions {
  /** Holder id written into the lock; defaults to this process. */
  readonly pid?: number;
  /** This holder's MCP socket, recorded in the lock so a later engine can ask it. */
  readonly socket?: string;
  /** Liveness probe for the pid in an existing lock; defaults to `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean;
  /** Called when a stale lock is taken over (the caller records a `stale_lock` incident). */
  readonly onStaleLock?: (holderPid: number | null, reason: StaleLockReason) => void;
  readonly now?: () => Date;
}

export interface TakeLockOptions extends AcquireLockOptions {
  /**
   * True when an engine answers the hello on `socket` (`engineSocketAnswers` of the mcp module:
   * core never imports a transport, AD-13).
   */
  readonly holderAnswers: (socket: string) => Promise<boolean>;
  /**
   * A lock younger than this is never judged by its socket: its holder may still be starting
   * (the socket is bound after the engine opened). Default {@link LOCK_STARTUP_GRACE_MS}.
   */
  readonly startupGraceMs?: number;
  /**
   * The waits between the hello probes: one more probe follows each. Default
   * {@link LOCK_PROBE_DELAYS_MS} (three probes over about 10 s with the client's 3 s timeout).
   */
  readonly probeDelaysMs?: readonly number[];
  /** Waits between probes (tests pass an immediate one). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The waits between hello probes before a live pid's silent lock counts as stale. */
export const LOCK_PROBE_DELAYS_MS: readonly number[] = [1_000, 3_000];

const sleepFor = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** How long a new holder may take to bind its socket before a silent socket counts as stale. */
export const LOCK_STARTUP_GRACE_MS = 2 * 60_000;

const errorCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
};

/** The holder a lock file names, or `null` when there is no lock file. */
export const readLockHolder = (path: string): LockHolder | null => {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: { pid?: unknown; acquired_at?: unknown; socket?: unknown } = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value !== null && typeof value === "object") parsed = value;
  } catch {
    // an unreadable lock names no holder
  }
  return {
    pid: typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null,
    acquiredAt: typeof parsed.acquired_at === "string" ? parsed.acquired_at : null,
    socket: typeof parsed.socket === "string" && parsed.socket !== "" ? parsed.socket : null,
    raw,
  };
};

const readHolder = (path: string): number | null => readLockHolder(path)?.pid ?? null;

/**
 * Takes the repo's engine lock or throws {@link EngineLockedError}. A lock whose holder's pid is
 * no longer alive is taken over once (`onStaleLock(pid, "dead")`). `staleHolder` names one more
 * lock, by its exact bytes, to take over though its pid lives: {@link takeEngineLock}'s verdict
 * on a silent socket (`onStaleLock(pid, "silent")`).
 */
export const acquireEngineLock = (
  repoRoot: string,
  options: AcquireLockOptions & { readonly staleHolder?: string } = {},
): EngineLock => {
  const path = join(repoRoot, ENGINE_INSTANCE.lockFile);
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? (() => new Date());
  mkdirSync(dirname(path), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const holder = readLockHolder(path);
      const holderPid = holder?.pid ?? null;
      const alive = holderPid !== null && isAlive(holderPid);
      const silent = alive && holder?.raw === options.staleHolder;
      if (alive && !silent) throw new EngineLockedError(path, holderPid);
      options.onStaleLock?.(holderPid, silent ? "silent" : "dead");
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    try {
      writeSync(
        fd,
        `${JSON.stringify({
          pid,
          acquired_at: now().toISOString(),
          ...(options.socket === undefined ? {} : { socket: options.socket }),
        })}\n`,
      );
    } finally {
      closeSync(fd);
    }
    let released = false;
    const lock: EngineLock = {
      path,
      pid,
      isHeld: () => !released && readHolder(path) === pid,
      release: () => {
        if (released) return;
        released = true;
        if (readHolder(path) !== pid) return;
        try {
          unlinkSync(path);
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      },
    };
    return lock;
  }
  throw new EngineLockedError(path, readHolder(path));
};

/**
 * {@link acquireEngineLock} plus the socket check (AD-12 rule 1): when the holder's pid is alive
 * but its socket (the one its lock records, else `options.socket`, the repo's own) answers none
 * of the hello probes (`probeDelaysMs` apart) and the lock is older than the startup grace, the
 * pid was reused and the lock is taken over (`onStaleLock(pid, "silent")`). A holder that
 * answers any probe keeps the lock, and so does a lock that changed hands between probes.
 */
export const takeEngineLock = async (
  repoRoot: string,
  options: TakeLockOptions,
): Promise<EngineLock> => {
  try {
    return acquireEngineLock(repoRoot, options);
  } catch (error) {
    if (!(error instanceof EngineLockedError)) throw error;
    const holder = readLockHolder(error.lockPath);
    const socket = holder?.socket ?? options.socket ?? null;
    if (holder === null || socket === null) throw error;
    const now = (options.now ?? (() => new Date()))().getTime();
    const acquired = holder.acquiredAt === null ? Number.NaN : Date.parse(holder.acquiredAt);
    const grace = options.startupGraceMs ?? LOCK_STARTUP_GRACE_MS;
    // a lock with no readable start time is judged by its socket; a young one is left alone
    if (!Number.isNaN(acquired) && now - acquired < grace) throw error;
    const delays = options.probeDelaysMs ?? LOCK_PROBE_DELAYS_MS;
    const sleep = options.sleep ?? sleepFor;
    for (let probe = 0; ; probe += 1) {
      if (await options.holderAnswers(socket)) throw error;
      const delay = delays[probe];
      if (delay === undefined) break;
      await sleep(delay);
      // another engine took the lock meanwhile: it is not the one judged silent
      if (readLockHolder(error.lockPath)?.raw !== holder.raw) throw error;
    }
    return acquireEngineLock(repoRoot, { ...options, staleHolder: holder.raw });
  }
};
