/**
 * One serial queue per target repo (AD-27 rule 1; spine §5 reading 208 (2)): every `gh` call to a
 * repo runs after the previous one finished; a mutating call waits at least
 * `AUTOMATION_LIMITS.minWriteIntervalMs` after the last one, at most
 * `AUTOMATION_LIMITS.mutatingCallsPerHour` run per rolling hour (beyond that the action is skipped
 * with `rate_limit`), and GitHub's secondary rate limit is backed off 60 s × 2^n for three tries in
 * all, then skipped with `github_rate_limit`.
 */
import { AUTOMATION_LIMITS } from "@vtc/shared";
import { isSecondaryRateLimit, type GhResult } from "./gh.js";
import { AutomationSkip } from "./skip.js";

/** First backoff after a secondary rate limit; doubles each time. */
export const SECONDARY_LIMIT_BACKOFF_MS = 60_000;
/** Tries of one mutating call, the first included. */
export const SECONDARY_LIMIT_TRIES = 3;
const HOUR_MS = 3_600_000;

export interface RepoQueueOptions {
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly minWriteIntervalMs?: number;
  readonly mutatingCallsPerHour?: number;
}

export interface RepoQueue {
  /** Runs a read in the repo's queue. */
  read<T>(repo: string, call: () => Promise<T>): Promise<T>;
  /** Runs a mutating `gh` call in the repo's queue, paced and backed off. */
  write(repo: string, call: () => Promise<GhResult>): Promise<GhResult>;
}

/** Runs tasks with the same key one after another (tasks with other keys run freely). */
export const createKeyedSerial = (): (<T>(key: string, task: () => Promise<T>) => Promise<T>) => {
  const tails = new Map<string, Promise<unknown>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const next = (tails.get(key) ?? Promise.resolve()).then(task, task);
    const tail = next.catch(() => undefined);
    tails.set(key, tail);
    void tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
};

export const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const createRepoQueue = (options: RepoQueueOptions = {}): RepoQueue => {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const minInterval = options.minWriteIntervalMs ?? AUTOMATION_LIMITS.minWriteIntervalMs;
  const perHour = options.mutatingCallsPerHour ?? AUTOMATION_LIMITS.mutatingCallsPerHour;
  const serial = createKeyedSerial();
  const writes = new Map<string, number[]>();

  const oneWrite = async (repo: string, call: () => Promise<GhResult>): Promise<GhResult> => {
    const times = (writes.get(repo) ?? []).filter((t) => now() - t < HOUR_MS);
    writes.set(repo, times);
    if (times.length >= perHour) {
      throw new AutomationSkip(
        "rate_limit",
        `${String(perHour)} mutating gh calls to ${repo} in the last hour`,
      );
    }
    const last = times.at(-1);
    if (last !== undefined) {
      const wait = last + minInterval - now();
      if (wait > 0) await sleep(wait);
    }
    times.push(now());
    return call();
  };

  return {
    read: (repo, call) => serial(repo, call),
    write: (repo, call) =>
      serial(repo, async () => {
        for (let attempt = 0; ; attempt += 1) {
          const result = await oneWrite(repo, call);
          if (result.code === 0 || !isSecondaryRateLimit(result.stderr)) return result;
          if (attempt + 1 >= SECONDARY_LIMIT_TRIES) {
            throw new AutomationSkip(
              "github_rate_limit",
              `GitHub's secondary rate limit on ${repo} after ${String(SECONDARY_LIMIT_TRIES)} tries`,
            );
          }
          await sleep(SECONDARY_LIMIT_BACKOFF_MS * 2 ** attempt);
        }
      }),
  };
};
