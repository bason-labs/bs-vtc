/**
 * One serial queue per target repo (AD-27 rule 1; spine §5 reading 208 (2)): every `gh` call to a
 * repo runs after the previous one finished; a mutating call waits at least
 * `AUTOMATION_LIMITS.minWriteIntervalMs` after the last one, at most
 * `AUTOMATION_LIMITS.mutatingCallsPerHour` run per rolling hour (beyond that the action is skipped
 * with `rate_limit`), and GitHub's secondary rate limit is backed off 60 s × 2^n for three tries in
 * all, then skipped with `github_rate_limit`. With `pacing`, the write times of each repo are kept
 * in VTC's home under a lock file, so the interval and the hourly cap hold across every daemon on
 * the machine (AD-12 runs one per project, and they all report to the same upstream repo).
 */
import { join } from "node:path";
import { AUTOMATION_LIMITS } from "@vtc/shared";
import { withFileLock } from "./file-lock.js";
import { isSecondaryRateLimit, type GhResult } from "./gh.js";
import { ensureDirNoFollow, readNoFollow, repoFileName, writeFileNoFollow } from "./safe-fs.js";
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
  /** Where the shared write log lives: `dir` below the trusted `root` (VTC's home). */
  readonly pacing?: { readonly root: string; readonly dir: string };
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

/** The write times of each repo: reserves a slot (cap checked, interval waited, time recorded). */
interface WriteLog {
  reserve(repo: string): Promise<void>;
}

const reserveIn = async (
  times: number[],
  repo: string,
  limits: {
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    minInterval: number;
    perHour: number;
  },
): Promise<number[]> => {
  const recent = times.filter((t) => limits.now() - t < HOUR_MS);
  if (recent.length >= limits.perHour) {
    throw new AutomationSkip(
      "rate_limit",
      `${String(limits.perHour)} mutating gh calls to ${repo} in the last hour`,
    );
  }
  const last = recent.at(-1);
  if (last !== undefined) {
    const wait = last + limits.minInterval - limits.now();
    if (wait > 0) await limits.sleep(wait);
  }
  return [...recent, limits.now()];
};

const parseTimes = (text: string | null): number[] => {
  if (text === null) return [];
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? value.filter((t): t is number => typeof t === "number") : [];
  } catch {
    return [];
  }
};

export const createRepoQueue = (options: RepoQueueOptions = {}): RepoQueue => {
  const limits = {
    now: options.now ?? Date.now,
    sleep: options.sleep ?? realSleep,
    minInterval: options.minWriteIntervalMs ?? AUTOMATION_LIMITS.minWriteIntervalMs,
    perHour: options.mutatingCallsPerHour ?? AUTOMATION_LIMITS.mutatingCallsPerHour,
  };
  const serial = createKeyedSerial();
  const memory = new Map<string, number[]>();
  const pacing = options.pacing;
  const log: WriteLog =
    pacing === undefined
      ? {
          reserve: async (repo) => {
            memory.set(repo, await reserveIn(memory.get(repo) ?? [], repo, limits));
          },
        }
      : {
          reserve: async (repo) => {
            const dir = ensureDirNoFollow(pacing.root, pacing.dir, "the gh pacing log");
            const name = `${repoFileName(repo)}.json`;
            await withFileLock(
              join(dir, `${name}.lock`),
              async () => {
                const times = parseTimes(readNoFollow(join(dir, name), "the gh pacing log"));
                writeFileNoFollow(dir, name, JSON.stringify(await reserveIn(times, repo, limits)));
              },
              { now: limits.now },
            );
          },
        };

  const oneWrite = async (repo: string, call: () => Promise<GhResult>): Promise<GhResult> => {
    await log.reserve(repo);
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
          await limits.sleep(SECONDARY_LIMIT_BACKOFF_MS * 2 ** attempt);
        }
      }),
  };
};
