/**
 * The research `HttpClient` (`@vtc/shared`, spine AD-22 rule 1; owner: cli+binary team), which the
 * cli injects as `EngineDeps.http`. Over the runtime's `fetch`, with the network guard:
 * - HTTPS only, no user info in the URL;
 * - every hop (the first request and each redirect target) resolves its host and is refused when
 *   any address is private (`isPrivateAddress`: loopback, RFC 1918, link-local, ULA, metadata…);
 *   redirects are followed by hand (at most {@link MAX_REDIRECTS}) so each one is checked;
 * - no cookies: a request carrying one is refused and `set-cookie` never reaches the caller; a
 *   redirect to another origin drops every header but `accept`, `accept-language` and
 *   `user-agent`, so a fetcher's own key never leaves its origin;
 * - one deadline for the whole request (`timeoutMs`) and a byte cap on the decoded body
 *   (`maxBytes`); both reject.
 * The resolver is injected: the binary uses Bun's own DNS (`bunResolver`). Fetch resolves the host
 * again when it connects, so a DNS answer that changes between the two lookups (rebinding) is a
 * residual: the address check alone cannot close it without its own socket layer (connecting to
 * the vetted address with the host name as TLS server name needs `node:https`/`node:tls`, which
 * the runtime-safe built-ins do not list). What closes it in practice is HTTPS with the runtime's
 * default certificate validation, which this client never turns off: a rebound private service
 * would have to present a valid certificate for the attacker's host name, so the TLS handshake
 * fails before any request is sent. The cli team proposed a spine §7 residual row for this.
 */
import { isIP } from "node:net";
import {
  isPrivateAddress,
  type HttpClient,
  type HttpRequest,
  type HttpResponse,
} from "@vtc/shared";

/** Redirects followed per request; each target passes the guard. */
export const MAX_REDIRECTS = 5;

/** Headers a request may carry to another origin after a redirect. */
const CROSS_ORIGIN_HEADERS = new Set(["accept", "accept-language", "user-agent"]);
/** Headers no request may carry (no cookies, AD-22 rule 1). */
const FORBIDDEN_HEADERS = new Set(["cookie", "cookie2"]);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** The network guard refused a request (never retried). */
export class HttpGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpGuardError";
  }
}

export type Resolve = (hostname: string) => Promise<readonly string[]>;

export interface HttpClientDeps {
  readonly fetch: typeof globalThis.fetch;
  /** Every address `hostname` resolves to (A and AAAA). */
  readonly resolve: Resolve;
}

interface BunDns {
  lookup(hostname: string): Promise<readonly { readonly address: string }[]>;
}

/** Bun's resolver, inside the binary; `null` on a runtime without it. */
export const bunResolver = (): Resolve | null => {
  const dns = (globalThis as { Bun?: { dns?: BunDns } }).Bun?.dns;
  if (dns === undefined) return null;
  return async (hostname) => (await dns.lookup(hostname)).map((r) => r.address);
};

const checkUrl = (raw: string): URL => {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpGuardError(`not an absolute URL: ${raw}`);
  }
  if (url.protocol !== "https:") throw new HttpGuardError(`only https is allowed: ${url.origin}`);
  if (url.username !== "" || url.password !== "")
    throw new HttpGuardError("a URL with user info is refused");
  return url;
};

const checkHost = async (url: URL, resolve: Resolve): Promise<void> => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) === 0 ? await resolve(host) : [host];
  if (addresses.length === 0) throw new HttpGuardError(`${host} does not resolve`);
  const blocked = addresses.find((address) => isPrivateAddress(address));
  if (blocked !== undefined)
    throw new HttpGuardError(`${host} resolves to a private address (${blocked})`);
};

/**
 * Reads a response body, at most `maxBytes`: a declared length beyond it is refused before
 * reading, and the stream is cancelled as soon as the running count passes it, so the cap bounds
 * memory. `tooLarge` makes the error thrown.
 */
export const readCappedBody = async (
  response: Response,
  maxBytes: number,
  tooLarge: () => Error,
): Promise<Uint8Array> => {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw tooLarge();
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
};

const responseHeaders = (headers: Headers): Record<string, string> => {
  const out: Record<string, string> = {};
  headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (key !== "set-cookie" && key !== "set-cookie2") out[key] = value;
  });
  return out;
};

const requestHeaders = (request: HttpRequest): Record<string, string> => {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    const key = name.toLowerCase();
    if (FORBIDDEN_HEADERS.has(key)) throw new HttpGuardError("a request may not carry cookies");
    headers[key] = value;
  }
  return headers;
};

export const createHttpClient = (deps: HttpClientDeps): HttpClient => ({
  request: async (request: HttpRequest): Promise<HttpResponse> => {
    if (!(request.timeoutMs > 0) || !(request.maxBytes > 0))
      throw new HttpGuardError("timeoutMs and maxBytes must be positive");
    let headers = requestHeaders(request);
    let url = checkUrl(request.url);
    let method = request.method;
    let body = request.body;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new HttpGuardError(`timed out after ${String(request.timeoutMs)} ms`));
    }, request.timeoutMs);
    const deadline = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => {
        reject(controller.signal.reason as Error);
      });
    });
    deadline.catch(() => undefined);
    // A hop that ignores the signal (a slow resolver) still ends at the deadline.
    const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, deadline]);
    try {
      for (let hop = 0; ; hop += 1) {
        await bounded(checkHost(url, deps.resolve));
        const response = await bounded(
          deps.fetch(url, {
            method,
            headers,
            redirect: "manual",
            credentials: "omit",
            signal: controller.signal,
            ...(body === undefined ? {} : { body }),
          }),
        );
        const location = response.headers.get("location");
        if (REDIRECTS.has(response.status) && location !== null) {
          await response.body?.cancel();
          if (hop >= MAX_REDIRECTS)
            throw new HttpGuardError(`more than ${String(MAX_REDIRECTS)} redirects`);
          const next = checkUrl(new URL(location, url).toString());
          if (next.origin !== url.origin)
            headers = Object.fromEntries(
              Object.entries(headers).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name)),
            );
          // 301-303 turn a POST into a GET without a body; 307 and 308 keep both
          if (method === "POST" && response.status !== 307 && response.status !== 308) {
            method = "GET";
            body = undefined;
            delete headers["content-type"];
          }
          url = next;
          continue;
        }
        return {
          status: response.status,
          headers: responseHeaders(response.headers),
          body: await bounded(
            readCappedBody(
              response,
              request.maxBytes,
              () => new HttpGuardError(`response larger than ${String(request.maxBytes)} bytes`),
            ),
          ),
          url: url.toString(),
        };
      }
    } finally {
      clearTimeout(timer);
    }
  },
});
