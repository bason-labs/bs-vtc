/**
 * A cross-process lock file (AD-27 rule 1; spine §5 reading 208 (2)). AD-12 runs one daemon per
 * project repo, and every daemon on the machine reports to the same upstream repo, so the
 * list → decide → write sequence of one target repo and the write pacing are held under a lock in
 * VTC's home, not only an in-memory queue. The lock is an `O_EXCL|O_NOFOLLOW` file holding the
 * owner's pid, the time and a token; a lock whose pid is gone, or older than `staleMs`, is broken.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { createExclusive, readNoFollow } from "./safe-fs.js";

export interface FileLockOptions {
  /** Give up waiting after this long (default 10 minutes). */
  readonly timeoutMs?: number;
  /** A lock older than this is broken even if its pid seems alive (default 15 minutes). */
  readonly staleMs?: number;
  /** Poll interval while waiting (default 100 ms). */
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export const LOCK_TIMEOUT_MS = 10 * 60_000;
export const LOCK_STALE_MS = 15 * 60_000;

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
};

/** Pure: whether a lock file's `text` names a holder that is gone or too old. */
export const lockIsStale = (text: string, now: number, staleMs: number): boolean => {
  const [pidText, atText] = text.split("\n");
  const pid = Number(pidText);
  const at = Number(atText);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(at)) return true;
  return now - at > staleMs || !alive(pid);
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
    const held = readNoFollow(path, "the automation lock");
    if (held !== null && lockIsStale(held, now(), staleMs)) {
      // Break it only if it is still the same stale holder.
      if (readNoFollow(path, "the automation lock") === held) rmSync(path, { force: true });
      continue;
    }
    if (now() >= deadline) throw new Error("another VTC process holds the automation lock");
    await sleep(options.pollMs ?? 100);
  }
  try {
    return await task();
  } finally {
    const held = readNoFollow(path, "the automation lock");
    if (held?.includes(token) === true) rmSync(path, { force: true });
  }
};
