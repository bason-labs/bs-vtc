/**
 * The research quota of a run: how many network requests the role tools (`research_fetch`,
 * `fact_propose`) may make on behalf of one run. It bounds what a looping or steered role can cost
 * the run and ask of other people's servers; answers from the cache cost nothing and are served
 * past it. The engine's own fetches (the G2 re-check) take no quota.
 *
 * The daemon builds one {@link FetchQuota} and hands each role call's service the run's slot
 * ({@link FetchQuota.forRun}), since it builds a service per call. Counts live in memory: a
 * daemon restart starts them again.
 */
import { HttpGuardError, type HttpClient } from "@vtc/shared";

/** Network requests per run by default (a research-heavy design phase stays well inside it). */
export const RESEARCH_FETCH_MAX_PER_RUN = 200;

/** One run's share of the quota. */
export interface FetchQuotaSlot {
  readonly max: number;
  /** Takes one request from the run's quota: `false` when it is spent. */
  take(): boolean;
}

export interface FetchQuota {
  forRun(run: string): FetchQuotaSlot;
  /** Requests the run has taken. */
  used(run: string): number;
  /** Drops a finished run's count (call at `run.finished`, so the counts do not grow forever). */
  forget(run: string): void;
}

export const createFetchQuota = (max: number = RESEARCH_FETCH_MAX_PER_RUN): FetchQuota => {
  if (!Number.isInteger(max) || max < 1) {
    throw new RangeError("a research quota is a positive whole number of requests");
  }
  const used = new Map<string, number>();
  return {
    forRun: (run) => ({
      max,
      take: () => {
        const count = used.get(run) ?? 0;
        if (count >= max) return false;
        used.set(run, count + 1);
        return true;
      },
    }),
    used: (run) => used.get(run) ?? 0,
    forget: (run) => {
      used.delete(run);
    },
  };
};

/**
 * The client with each request charged to `slot`. A spent quota refuses the request as the network
 * guard does (`HttpGuardError`, code `guard`), so the fetch is `blocked`, never served stale.
 */
export const withQuota = (http: HttpClient, slot: FetchQuotaSlot): HttpClient => ({
  request: (request) =>
    slot.take()
      ? http.request(request)
      : Promise.reject(
          new HttpGuardError(
            `this run's research quota of ${String(slot.max)} network requests is spent`,
          ),
        ),
});
