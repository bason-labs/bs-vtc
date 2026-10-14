/**
 * Research seams (spine AD-22). The engine's `research/` module (lookback-research team) runs the
 * fetchers over an injected {@link HttpClient}: the cli builds one over the runtime's `fetch`
 * with the network guard; tests inject recorded fixtures, so no test touches the network.
 * New in contracts 4.5.0.
 */
import type {
  CacheEntry,
  FetcherId,
  FetchRequest,
  FetchResult,
  ResearchScope,
} from "../research.js";

export interface HttpRequest {
  /** Absolute https URL. */
  readonly url: string;
  readonly method: "GET" | "POST";
  /** Lower-case names. Never a cookie; an API key only for the fetcher that owns it. */
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  /** The response body is cut off (and the request fails) beyond this many bytes. */
  readonly maxBytes: number;
}

export interface HttpResponse {
  readonly status: number;
  /** Lower-case names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  /** The final URL after redirects (each redirect target passes the network guard too). */
  readonly url: string;
}

/**
 * HTTPS only; resolves DNS and refuses private addresses (`isPrivateAddress`) on every hop; no
 * cookies; byte caps and timeouts. A redirect to another origin (scheme, host or port) forwards
 * only `accept`, `accept-language` and `user-agent`, never `authorization` or a key header
 * (spine §5 reading 129). Errors reject; a refusal by the guard or a timeout rejects with an
 * {@link HttpGuardError}, anything else with a plain `Error`.
 */
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

/** The `name` of every {@link HttpGuardError}. New in 4.6.0. */
export const HTTP_GUARD_ERROR = "HttpGuardError";

/**
 * Why an {@link HttpClient} refused a request (`guard`: https only, a private address, a byte cap,
 * a header it will not send) or gave up on it (`timeout`). Callers match `name` and `code`, never
 * the message. New in 4.6.0.
 */
export class HttpGuardError extends Error {
  readonly code: "guard" | "timeout";

  constructor(message: string, code: "guard" | "timeout" = "guard", options?: ErrorOptions) {
    super(message, options);
    this.name = HTTP_GUARD_ERROR;
    this.code = code;
  }
}

/** A per-scope, content-addressed cache under `~/.vtc/research-cache/<scope>/` (`RESEARCH_CACHE`). */
export interface ResearchCache {
  /** The newest index entry for `key` (`canonicalCacheKey`) in `scope`, or `undefined`. */
  get(scope: ResearchScope, key: string): Promise<CacheEntry | undefined>;
  /** Stores the body as a blob and appends the index entry. */
  put(scope: ResearchScope, entry: CacheEntry, body: Uint8Array): Promise<void>;
  /** The blob with this SHA-256 in `scope`, or `undefined`. Never looks in another scope. */
  blob(scope: ResearchScope, sha256: string): Promise<Uint8Array | undefined>;
}

export interface FetchContext {
  readonly http: HttpClient;
  readonly cache: ResearchCache;
  readonly scope: ResearchScope;
  readonly now: () => Date;
  /**
   * The value of a user-named API key variable (`~/.vtc/config.yaml` names it; the value comes
   * from the environment at call time and is a known value for `redactSecrets`). `undefined` when
   * unset. Never a host credential (AD-9).
   */
  readonly apiKey?: (name: string) => string | undefined;
}

/** One deterministic fetcher (§8.2, §10). */
export interface Fetcher {
  readonly id: FetcherId;
  /** Part of the cache key: bump it when the fetcher's parsing or the upstream API changes. */
  readonly version: string;
  fetch(request: FetchRequest, context: FetchContext): Promise<FetchResult>;
}
