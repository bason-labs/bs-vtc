/**
 * Single-writer lock (AD-12): one engine per repo. The holder is the only process allowed to
 * append to `.vtc/runs/<run>/events.jsonl` (AD-7 rule 2). Exclusive create (`wx`) is atomic on
 * every local filesystem both runtimes support.
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

export interface AcquireLockOptions {
  /** Holder id written into the lock; defaults to this process. */
  readonly pid?: number;
  /** Liveness probe for the pid in an existing lock; defaults to `process.kill(pid, 0)`. */
  readonly isAlive?: (pid: number) => boolean;
  /** Called when a lock left by a dead process is taken over (the caller records an incident). */
  readonly onStaleLock?: (holderPid: number | null) => void;
  readonly now?: () => Date;
}

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

const readHolder = (path: string): number | null => {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    return typeof parsed.pid === "number" && Number.isInteger(parsed.pid) ? parsed.pid : null;
  } catch {
    return null;
  }
};

/**
 * Takes the repo's engine lock or throws {@link EngineLockedError}. A lock whose holder is no
 * longer alive is taken over once (`onStaleLock`).
 */
export const acquireEngineLock = (
  repoRoot: string,
  options: AcquireLockOptions = {},
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
      const holder = readHolder(path);
      if (holder !== null && isAlive(holder)) throw new EngineLockedError(path, holder);
      options.onStaleLock?.(holder);
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if (errorCode(unlinkError) !== "ENOENT") throw unlinkError;
      }
      continue;
    }
    try {
      writeSync(fd, `${JSON.stringify({ pid, acquired_at: now().toISOString() })}\n`);
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
