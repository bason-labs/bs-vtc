/**
 * Browser sessions (AD-5 rule 2): `vtc dashboard` mints a single-use nonce (valid 60 s) that the
 * page exchanges once for a random session token (12 h, dies with the process). Neither is ever
 * the install token, and nothing is a cookie.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ENGINE_SESSION, type SessionExchangeResult, type SessionNonceResult } from "@vtc/shared";

/** 256 random bits, base64url (43 characters). */
export const randomToken = (): string => randomBytes(32).toString("base64url");

/** Constant-time string comparison for secrets. */
export const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export interface SessionStore {
  mintNonce(): SessionNonceResult;
  /** The session for a fresh, unused nonce; `null` otherwise (the nonce is spent either way). */
  exchange(nonce: string): SessionExchangeResult | null;
  isSession(token: string): boolean;
}

export const createSessionStore = (now: () => Date = () => new Date()): SessionStore => {
  const nonces = new Map<string, number>();
  const sessions = new Map<string, number>();
  const sweep = (): void => {
    const t = now().getTime();
    for (const [k, exp] of nonces) if (exp <= t) nonces.delete(k);
    for (const [k, exp] of sessions) if (exp <= t) sessions.delete(k);
  };
  return {
    mintNonce: () => {
      sweep();
      const nonce = randomToken();
      const expires = now().getTime() + ENGINE_SESSION.nonceTtlMs;
      nonces.set(nonce, expires);
      return { nonce, expires_at: new Date(expires).toISOString() };
    },
    exchange: (nonce) => {
      const expires = nonces.get(nonce);
      nonces.delete(nonce);
      if (expires === undefined || expires <= now().getTime()) return null;
      const session = randomToken();
      const sessionExpires = now().getTime() + ENGINE_SESSION.sessionTtlMs;
      sessions.set(session, sessionExpires);
      return { session, expires_at: new Date(sessionExpires).toISOString() };
    },
    isSession: (token) => {
      const expires = sessions.get(token);
      if (expires === undefined) return false;
      if (expires <= now().getTime()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
  };
};
