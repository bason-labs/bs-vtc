import { ENGINE_HTTP, SessionExchangeResultSchema } from "@vtc/shared";

/**
 * Browser session (AD-5 rule 2). `vtc dashboard` opens `/#nonce=<nonce>`: a fragment, never sent
 * to a server. The page strips it from the URL at once, exchanges it (once) with
 * `POST /api/session` for a session token, keeps the token in `sessionStorage` (origin-scoped, so
 * other 127.0.0.1 ports cannot read it) and sends it as `Authorization: Bearer`. No cookies.
 */
export const SESSION_STORAGE_KEY = "vtc.session";

const NONCE = /^[A-Za-z0-9_-]{43,128}$/;

/** The nonce from a URL fragment like `#nonce=…`, or `null`. */
export const readNonce = (hash: string): string | null => {
  const value = new URLSearchParams(hash.replace(/^#/, "")).get("nonce");
  return value !== null && NONCE.test(value) ? value : null;
};

export type SessionStatus = "none" | "restored" | "exchanged" | "failed";

export interface SessionResult {
  readonly status: SessionStatus;
  readonly token: string | null;
}

export interface SessionDeps {
  /** `location.hash` at startup. */
  readonly hash: string;
  /** Removes the fragment from the address bar and history (`history.replaceState`). */
  readonly replaceUrl: () => void;
  readonly storage: Storage | null;
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly now: () => number;
}

const NONE: SessionResult = { status: "none", token: null };

const restore = (deps: SessionDeps): SessionResult => {
  let raw: string | null;
  try {
    raw = deps.storage?.getItem(SESSION_STORAGE_KEY) ?? null;
  } catch {
    return NONE;
  }
  if (raw === null) return NONE;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = null;
  }
  const parsed = SessionExchangeResultSchema.safeParse(value);
  if (parsed.success && Date.parse(parsed.data.expires_at) > deps.now()) {
    return { status: "restored", token: parsed.data.session };
  }
  try {
    deps.storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing to clean up.
  }
  return NONE;
};

const exchange = async (nonce: string, deps: SessionDeps): Promise<SessionResult> => {
  let response: Response;
  try {
    response = await deps.fetch(ENGINE_HTTP.routes.session.path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      credentials: "omit",
      cache: "no-store",
      body: JSON.stringify({ nonce }),
    });
  } catch {
    return { status: "failed", token: null };
  }
  if (!response.ok) return { status: "failed", token: null };
  const parsed = SessionExchangeResultSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) return { status: "failed", token: null };
  try {
    deps.storage?.setItem(SESSION_STORAGE_KEY, JSON.stringify(parsed.data));
  } catch {
    // Storage blocked: the token lives in memory for this page only.
  }
  return { status: "exchanged", token: parsed.data.session };
};

/** Forgets the stored session (after the engine refused it), so a reload does not retry it. */
export const clearStoredSession = (storage: Storage | null): void => {
  try {
    storage?.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Storage blocked: nothing stored.
  }
};

/**
 * The nonce exchange in flight, if any. The nonce is single-use and leaves the URL before the
 * exchange answers, so a second bootstrap meanwhile (React StrictMode runs effects twice in
 * development; a remount) waits for this one instead of finding neither a nonce nor a session.
 */
let inflight: { readonly nonce: string; readonly result: Promise<SessionResult> } | null = null;

/**
 * The page's session: the `#nonce=` exchanged once, else the stored session, else none. Safe to
 * call again while an exchange is in flight: later calls share its result.
 */
export const bootstrapSession = async (deps: SessionDeps): Promise<SessionResult> => {
  const nonce = readNonce(deps.hash);
  if (inflight !== null && (nonce === null || nonce === inflight.nonce)) return inflight.result;
  if (nonce === null) return restore(deps);
  // Strip first: the nonce must not stay in the address bar or history, even if the exchange fails.
  deps.replaceUrl();
  const result = exchange(nonce, deps);
  const current = { nonce, result };
  inflight = current;
  try {
    return await result;
  } finally {
    if (inflight === current) inflight = null;
  }
};
