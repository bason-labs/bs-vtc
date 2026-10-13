"use client";

import { useEffect, useRef, useState } from "react";
import { useEngine } from "@/components/app/EngineProvider";
import type { EngineClient } from "./api/client";

export interface Resource<T> {
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
  readonly reload: () => void;
}

interface State<T> {
  readonly key: string | null;
  readonly data: T | undefined;
  readonly error: unknown;
  readonly loading: boolean;
}

/**
 * Reads one engine route and keeps it fresh: re-reads when any of `topics` goes stale (a live
 * event, `topics.ts`). `key` names what is read; a new key drops the old data, so a view never
 * shows another run's data. `null` = nothing to read (e.g. a missing query parameter).
 */
export function useResource<T>(
  key: string | null,
  load: (client: EngineClient, signal: AbortSignal) => Promise<T>,
  topics: readonly string[] = [],
): Resource<T> {
  const { client, bus, ready } = useEngine();
  const loadRef = useRef(load);
  loadRef.current = load;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<State<T>>({
    key,
    data: undefined,
    error: null,
    loading: key !== null,
  });
  const topicKey = topics.join("|");

  if (state.key !== key) {
    setState({ key, data: undefined, error: null, loading: key !== null });
  }

  useEffect(() => {
    if (topicKey === "") return;
    const offs = topicKey.split("|").map((t) =>
      bus.subscribe(t, () => {
        setVersion((v) => v + 1);
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [bus, topicKey]);

  useEffect(() => {
    if (key === null || !ready) return;
    const controller = new AbortController();
    setState((s) => (s.key === key ? { ...s, loading: true } : s));
    loadRef.current(client, controller.signal).then(
      (data) => {
        if (!controller.signal.aborted) setState({ key, data, error: null, loading: false });
      },
      (error: unknown) => {
        if (!controller.signal.aborted)
          setState((s) => ({
            key,
            data: s.key === key ? s.data : undefined,
            error,
            loading: false,
          }));
      },
    );
    return () => {
      controller.abort();
    };
  }, [key, ready, client, version]);

  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : null,
    loading: state.key === key ? state.loading : key !== null,
    reload: () => {
      setVersion((v) => v + 1);
    },
  };
}
