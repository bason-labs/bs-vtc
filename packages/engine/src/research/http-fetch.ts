/**
 * One cached HTTP fetch (AD-22 rules 1–2, RFC 9111). Every built-in fetcher goes through here:
 *
 * - a fresh entry (younger than the fetcher's TTL) is served from the cache (`hit`);
 * - a stale entry is revalidated with `If-None-Match` / `If-Modified-Since`; a 304 refreshes its
 *   age and keeps the blob (`revalidated`);
 * - a new body is stored as a content-addressed blob (`miss`);
 * - when the network fails, or the server errors, a stale entry is served as `stale`, so facts
 *   from it are `stale` too;
 * - a URL or redirect target that is not https, or a body over the byte cap, is `blocked`.
 *
 * HTTP comes only from the injected `HttpClient` (`FetchContext.http`), which also enforces the
 * network guard (private addresses after DNS on every hop, timeouts, no cookies).
 */
import {
  canonicalCacheKey,
  FETCHER_TTL_DAYS,
  type CacheEntry,
  type FetchContext,
  type FetcherId,
  type FetchRequest,
  type FetchResult,
  type HttpRequest,
} from "@vtc/shared";
import { sha256Bytes } from "./files.js";
import type { RequestMemory } from "./cache.js";

/** Network limits of one research request. */
export const RESEARCH_HTTP_LIMITS = {
  timeoutMs: 20_000,
  /** 5 MiB: generous for an API response or an article, small enough to keep the cache sane. */
  maxBytes: 5 * 1024 * 1024,
  /** Identifies VTC to servers and to robots.txt groups (RFC 9309). */
  userAgent: "vtc-research/1",
} as const;

/** A converted body to store instead of the raw response (the `web` fetcher stores markdown). */
export interface StoredBody {
  readonly body: Uint8Array;
  readonly contentType: string | null;
}

export interface CachedFetchSpec {
  readonly fetcher: FetcherId;
  readonly version: string;
  readonly request: FetchRequest;
  readonly url: string;
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Freshness in days; defaults to `FETCHER_TTL_DAYS[fetcher]`. */
  readonly ttlDays?: number;
  /**
   * Checks the final URL after redirects before anything is stored: a reason makes the result
   * `blocked` (the `web` fetcher re-checks robots.txt for a redirect to another origin).
   */
  readonly checkFinalUrl?: (finalUrl: string) => Promise<string | undefined>;
  /** Converts a 2xx body before it is stored and hashed. */
  readonly transform?: (body: Uint8Array, contentType: string | null) => StoredBody;
}

/** The fetch context, optionally with the request memory of a file cache. */
export type CachedFetchContext = FetchContext & { readonly requests?: RequestMemory };

const DETAIL_MAX = 500;

const clip = (text: string): string =>
  text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX - 1)}…` : text;

const errorText = (error: unknown): string =>
  clip(error instanceof Error && error.message !== "" ? error.message : String(error));

/**
 * The cli's client rejects a guard refusal with an `Error` named `HttpGuardError` (it also uses it
 * for its deadline, which is a timeout, not a refusal). Until `HttpClient` names the refusal in
 * `@vtc/shared` (a contract proposal), the name is the signal.
 */
export const HTTP_GUARD_ERROR_NAME = "HttpGuardError";

const isGuardRefusal = (error: unknown): boolean =>
  error instanceof Error &&
  error.name === HTTP_GUARD_ERROR_NAME &&
  !error.message.startsWith("timed out");

const isFresh = (entry: CacheEntry, now: Date): boolean =>
  now.getTime() - Date.parse(entry.retrieved_at) < entry.ttl_s * 1000;

const ttlSeconds = (spec: CachedFetchSpec): number =>
  Math.round((spec.ttlDays ?? FETCHER_TTL_DAYS[spec.fetcher]) * 86_400);

/** Runs one fetch through the cache of `context.scope`. Never throws for a network failure. */
export const cachedFetch = async (
  spec: CachedFetchSpec,
  context: CachedFetchContext,
): Promise<FetchResult> => {
  const now = context.now();
  const key = canonicalCacheKey(spec.version, spec.request);
  const method = spec.method ?? "GET";
  const base = {
    fetcher: spec.fetcher,
    fetcher_version: spec.version,
    url: spec.url,
    retrieved_at: now.toISOString(),
  };
  const empty = (
    status: FetchResult["status"],
    httpStatus: number | null,
    detail: string,
  ): FetchResult => ({
    ...base,
    status,
    cache: "miss",
    http_status: httpStatus,
    content_type: null,
    content_sha256: null,
    bytes: 0,
    detail: clip(detail),
  });
  const fromEntry = (
    entry: CacheEntry,
    bytes: number,
    cache: FetchResult["cache"],
    detail?: string,
  ): FetchResult => ({
    fetcher: spec.fetcher,
    fetcher_version: spec.version,
    url: entry.url,
    status: "ok",
    cache,
    http_status: entry.http_status,
    content_type: entry.content_type,
    content_sha256: entry.content_sha256,
    bytes,
    // When the cached content was retrieved (or last revalidated): a fact's freshness counts from it.
    retrieved_at: entry.retrieved_at,
    ...(detail === undefined ? {} : { detail: clip(detail) }),
  });

  if (!spec.url.startsWith("https://")) return empty("blocked", null, "fetchers use https only");

  const found = await context.cache.get(context.scope, key);
  const blob =
    found === undefined ? undefined : await context.cache.blob(context.scope, found.content_sha256);
  const entry = blob === undefined ? undefined : found;
  if (entry !== undefined && blob !== undefined && isFresh(entry, now)) {
    return fromEntry(entry, blob.length, "hit");
  }
  const serveStale = (detail: string, httpStatus: number | null = null): FetchResult =>
    entry !== undefined && blob !== undefined
      ? fromEntry(entry, blob.length, "stale", detail)
      : empty("error", httpStatus, detail);

  const headers: Record<string, string> = {
    "user-agent": RESEARCH_HTTP_LIMITS.userAgent,
    ...spec.headers,
  };
  if (entry !== undefined && method === "GET") {
    if (entry.etag !== undefined) headers["if-none-match"] = entry.etag;
    if (entry.last_modified !== undefined) headers["if-modified-since"] = entry.last_modified;
  }
  const request: HttpRequest = {
    url: spec.url,
    method,
    headers,
    timeoutMs: RESEARCH_HTTP_LIMITS.timeoutMs,
    maxBytes: RESEARCH_HTTP_LIMITS.maxBytes,
    ...(spec.body === undefined ? {} : { body: spec.body }),
  };

  let response;
  try {
    response = await context.http.request(request);
  } catch (error) {
    // The network guard refused the request (a private address, a redirect off https, the cap):
    // `blocked`, never a stale copy. Any other failure (offline, a timeout) serves stale.
    if (isGuardRefusal(error)) return empty("blocked", null, errorText(error));
    return serveStale(errorText(error));
  }
  if (!response.url.startsWith("https://")) {
    return empty("blocked", response.status, "a redirect left https");
  }
  if (response.body.length > RESEARCH_HTTP_LIMITS.maxBytes) {
    return empty("blocked", response.status, "the response is over the byte cap");
  }
  if (response.url !== spec.url && spec.checkFinalUrl !== undefined) {
    const refused = await spec.checkFinalUrl(response.url);
    if (refused !== undefined) return empty("blocked", response.status, refused);
  }
  const validators = (h: Readonly<Record<string, string>>): Partial<CacheEntry> => ({
    ...(h.etag === undefined || h.etag === "" ? {} : { etag: h.etag.slice(0, 512) }),
    ...(h["last-modified"] === undefined || h["last-modified"] === ""
      ? {}
      : { last_modified: h["last-modified"].slice(0, 100) }),
  });

  if (response.status === 304 && entry !== undefined && blob !== undefined) {
    const refreshed: CacheEntry = {
      ...entry,
      ...validators(response.headers),
      retrieved_at: now.toISOString(),
      ttl_s: ttlSeconds(spec),
    };
    await context.cache.put(context.scope, refreshed, blob);
    return fromEntry(refreshed, blob.length, "revalidated");
  }
  if (response.status === 404 || response.status === 410) {
    return empty("not_found", response.status, `HTTP ${String(response.status)}`);
  }
  if (response.status < 200 || response.status > 299) {
    return serveStale(`HTTP ${String(response.status)}`, response.status);
  }

  const rawType = response.headers["content-type"];
  const contentType = rawType === undefined || rawType === "" ? null : rawType.slice(0, 200);
  const stored: StoredBody =
    spec.transform === undefined
      ? { body: response.body, contentType }
      : spec.transform(response.body, contentType);
  const sha = sha256Bytes(stored.body);
  const newEntry: CacheEntry = {
    v: 1,
    key,
    fetcher: spec.fetcher,
    fetcher_version: spec.version,
    url: response.url,
    retrieved_at: now.toISOString(),
    ttl_s: ttlSeconds(spec),
    ...validators(response.headers),
    http_status: response.status,
    content_type: stored.contentType,
    content_sha256: sha,
  };
  await context.cache.put(context.scope, newEntry, stored.body);
  await context.requests?.remember(context.scope, key, spec.request);
  return fromEntry(newEntry, stored.body.length, "miss");
};
