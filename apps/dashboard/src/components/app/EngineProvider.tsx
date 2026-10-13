"use client";

import { CONTRACTS_VERSION, type HealthResult } from "@vtc/shared";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createEngineClient, type EngineClient } from "@/lib/api/client";
import { connectLiveStream, type LiveStatus } from "@/lib/api/live";
import { bootstrapSession, type SessionStatus } from "@/lib/api/session";
import { createInvalidationBus, topicKeysForEvent, type InvalidationBus } from "@/lib/api/topics";

export type ConnectionState =
  | { readonly kind: "starting" }
  | { readonly kind: "live" | "reconnecting" | "connecting" | "closed" }
  | { readonly kind: "snapshot" }
  | { readonly kind: "unauthorized" };

interface EngineContextValue {
  readonly client: EngineClient;
  readonly bus: InvalidationBus;
  /** `null` until the session bootstrap finished (no request goes out before it). */
  readonly ready: boolean;
  readonly session: SessionStatus;
  readonly health: HealthResult | null;
  readonly connection: ConnectionState;
}

const EngineContext = createContext<EngineContextValue | null>(null);

export interface EngineProviderProps {
  readonly children: ReactNode;
  /** Injected in tests; the browser's `fetch` otherwise. */
  readonly fetchImpl?: typeof fetch;
}

const browserStorage = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

/**
 * Talks to the engine only over HTTP/SSE (AD-1 rule 5, AD-5): exchanges the `#nonce=` for a
 * session token before any request, reads `/api/health`, and follows `/api/stream`, turning each
 * event into stale topics that the views re-read.
 */
export function EngineProvider({ children, fetchImpl }: EngineProviderProps) {
  const fetcher = useMemo<typeof fetch>(
    () => fetchImpl ?? ((input, init) => window.fetch(input, init)),
    [fetchImpl],
  );
  const token = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<SessionStatus>("none");
  const [health, setHealth] = useState<HealthResult | null>(null);
  const [live, setLive] = useState<LiveStatus | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const bus = useMemo(() => createInvalidationBus(), []);
  const onUnauthorized = useCallback(() => {
    setUnauthorized(true);
  }, []);
  const client = useMemo(
    () => createEngineClient({ fetch: fetcher, getToken: () => token.current, onUnauthorized }),
    [fetcher, onUnauthorized],
  );

  useEffect(() => {
    let cancelled = false;
    void bootstrapSession({
      hash: window.location.hash,
      replaceUrl: () => {
        window.history.replaceState(
          window.history.state,
          "",
          `${window.location.pathname}${window.location.search}`,
        );
      },
      storage: browserStorage(),
      fetch: (url, init) => fetcher(url, init),
      now: () => Date.now(),
    }).then((result) => {
      if (cancelled) return;
      token.current = result.token;
      setSession(result.status);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [fetcher]);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    client.health(controller.signal).then(setHealth, () => undefined);
    const close = connectLiveStream({
      openStream: (lastId, signal) => client.openStream(lastId, signal),
      onEvent: (event) => {
        bus.invalidate(topicKeysForEvent(event));
      },
      onStatus: setLive,
    });
    return () => {
      controller.abort();
      close();
    };
  }, [ready, client, bus]);

  const connection: ConnectionState = useMemo(() => {
    if (unauthorized || live === "unauthorized" || session === "failed")
      return { kind: "unauthorized" };
    if (!ready) return { kind: "starting" };
    // `vtc dashboard` over the committed .vtc/ (AD-5 rule 7): read-only, nothing new arrives.
    if (health?.mode === "snapshot") return { kind: "snapshot" };
    return { kind: live ?? "connecting" };
  }, [unauthorized, live, session, ready, health]);

  const value = useMemo(
    () => ({ client, bus, ready, session, health, connection }),
    [client, bus, ready, session, health, connection],
  );
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>;
}

export function useEngine(): EngineContextValue {
  const ctx = useContext(EngineContext);
  if (ctx === null) throw new Error("useEngine must be used within an EngineProvider");
  return ctx;
}

/** Major version of a `x.y.z` string. */
const major = (version: string): string => version.split(".")[0] ?? version;

/** True when the engine speaks a different contracts MAJOR than this dashboard was built with. */
export const contractsMismatch = (health: HealthResult | null): boolean =>
  health !== null && major(health.contracts_version) !== major(CONTRACTS_VERSION);
