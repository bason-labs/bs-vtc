/**
 * A cross-process lock file (AD-27 rule 1; spine §5 reading 208 (2)). AD-12 runs one daemon per
 * project repo, and every daemon on the machine reports to the same upstream repo, so the
 * list → decide → write sequence of one target repo and the write pacing are held under a lock in
 * VTC's home, not only an in-memory queue. The lock is an `O_EXCL|O_NOFOLLOW` file holding the
 * owner's pid, the time and a token. The holder touches the file's mtime every `staleMs / 3`
 * while its task runs (a heartbeat), so a slow but live task is never taken for stale. A lock is
 * stale when its pid is gone, or when neither its time nor its heartbeat is newer than `staleMs`.
 *
 * Breaking a stale lock is check-then-remove, so it runs under a second exclusive file
 * (`<lock>.break`): only one waiter at a time re-reads the lock, and it removes the lock only if
 * it still holds the same stale content, so a waiter that read the old content can never remove
 * the fresh lock another waiter just took. The break file is held for a few synchronous calls;
 * one left by a process that died in between (pid gone, or older than `BREAK_STALE_MS`) is
 * removed.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  futimesSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createExclusive, readNoFollow } from "./safe-fs.js";

export interface FileLockOptions {
  /** Give up waiting after this long (default 10 minutes). */
  readonly timeoutMs?: number;
  /**
   * A lock with no heartbeat for this long is broken even if its pid seems alive (default 15
   * minutes; the holder's heartbeat runs every third of it).
   */
  readonly staleMs?: number;
  /** Poll interval while waiting (default 100 ms). */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const LOCK_TIMEOUT_MS = 10 * 60_000;
export const LOCK_STALE_MS = 15 * 60_000;
/** A break file older than this was left by a process that died while breaking a lock. */
export const BREAK_STALE_MS = 30_000;

const NOFOLLOW: number = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
};

/**
 * Whether a lock file's `text` names a holder that is gone or too old. `touchedAt` is the file's
 * last heartbeat (its mtime), which keeps a live holder fresh.
 */
export const lockIsStale = (
  text: string,
  now: number,
  staleMs: number,
  touchedAt?: number,
): boolean => {
  const [pidText, atText] = text.split("\n");
  const pid = Number(pidText);
  const at = Number(atText);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return true;
  const last = Math.max(at, touchedAt ?? Number.NEGATIVE_INFINITY);
  return now - last > staleMs || !alive(pid);
};

/** The lock's text and mtime (never through a symlink), or `null` when it does not exist. */
const readLock = (path: string): { text: string; touchedAt: number } | null => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    // A symlink (ELOOP) or anything else unreadable is never a lock VTC may break.
    throw new Error("the automation lock is not a plain file", { cause: error });
  }
  try {
    return { text: readFileSync(fd, "utf8"), touchedAt: fstatSync(fd).mtimeMs };
  } finally {
    closeSync(fd);
  }
};

/** Touches the lock's mtime when it still holds `token` (the file read is the file touched). */
const heartbeat = (path: string, token: string): void => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch {
    return;
  }
  try {
    if (readFileSync(fd, "utf8").includes(token)) {
      const t = new Date();
      futimesSync(fd, t, t);
    }
  } catch {
    // A missed heartbeat only brings forward the time the lock may be taken for stale.
  } finally {
    closeSync(fd);
  }
};

/**
 * Removes the lock at `path` only if it still holds `held`, under the `.break` file; true when
 * this call removed it. A break file a dead process left is removed for the next try.
 */
const breakStale = (path: string, held: string, now: number): boolean => {
  const guard = `${path}.break`;
  if (!createExclusive(guard, `${String(process.pid)}\n${String(now)}\n`)) {
    const other = readLock(guard);
    if (other !== null && lockIsStale(other.text, now, BREAK_STALE_MS)) {
      rmSync(guard, { force: true });
    }
    return false;
  }
  try {
    if (readLock(path)?.text !== held) return false;
    rmSync(path, { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `task` while holding the lock file at `path` (its directory must exist). */
export const withFileLock = async <T>(
  path: string,
  task: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const deadline = now() + (options.timeoutMs ?? LOCK_TIMEOUT_MS);
  const token = randomBytes(8).toString("hex");
  for (;;) {
    if (createExclusive(path, `${String(process.pid)}\n${String(now())}\n${token}\n`)) break;
    const held = readLock(path);
    // Released meanwhile, or this waiter broke the stale lock: try to take it right away.
    if (held === null) continue;
    if (
      lockIsStale(held.text, now(), staleMs, held.touchedAt) &&
      breakStale(path, held.text, now())
    ) {
      continue;
    }
    if (now() >= deadline) throw new Error("another VTC process holds the automation lock");
    await sleep(options.pollMs ?? 100);
  }
  const beat = setInterval(
    () => {
      heartbeat(path, token);
    },
    Math.max(1, Math.floor(staleMs / 3)),
  );
  beat.unref();
  try {
    return await task();
  } finally {
    clearInterval(beat);
    const held = readNoFollow(path, "the automation lock");
    if (held?.includes(token) === true) rmSync(path, { force: true });
  }
};
