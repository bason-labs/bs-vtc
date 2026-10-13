import { EventSchema, parsePersisted, sseEventId, type VtcEvent } from "@vtc/shared";
import { isAuthError } from "./errors";
import { readSseStream } from "./sse";

/** Connection state of the live event stream, shown in the header. */
export type LiveStatus = "connecting" | "live" | "reconnecting" | "unauthorized" | "closed";

export interface LiveStreamOptions {
  readonly openStream: (
    lastEventId: string | null,
    signal: AbortSignal,
  ) => Promise<ReadableStream<Uint8Array>>;
  readonly onEvent: (event: VtcEvent) => void;
  readonly onStatus: (status: LiveStatus) => void;
  /** Waits between reconnects (injected for tests). */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const FIRST_DELAY_MS = 1000;
const MAX_DELAY_MS = 30_000;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Reads `GET /api/stream` (AD-5 rule 6): one `Event` per message, `id: <run>:<seq>`. Reconnects
 * with `Last-Event-ID` and exponential backoff; delivers each (run, seq) at most once; stops for
 * good when the engine refuses the session. Returns `close`.
 */
export const connectLiveStream = (options: LiveStreamOptions): (() => void) => {
  const controller = new AbortController();
  const { signal } = controller;
  const sleep = options.sleep ?? defaultSleep;
  const lastSeq = new Map<string, number>();
  let lastId: string | null = null;
  let status: LiveStatus | null = null;
  const setStatus = (next: LiveStatus): void => {
    if (next === status) return;
    status = next;
    options.onStatus(next);
  };

  const handle = (data: string, id: string | null): void => {
    let raw: unknown;
    try {
      raw = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = parsePersisted(EventSchema, raw);
    if (!parsed.success) return;
    const event = parsed.data;
    lastId = id ?? sseEventId(event.run, event.seq);
    if (event.seq <= (lastSeq.get(event.run) ?? 0)) return;
    lastSeq.set(event.run, event.seq);
    options.onEvent(event);
  };

  // A function, so the checks below re-read the signal after each await.
  const stopped = (): boolean => signal.aborted;

  const run = async (): Promise<void> => {
    let delay = FIRST_DELAY_MS;
    setStatus("connecting");
    while (!stopped()) {
      try {
        const body = await options.openStream(lastId, signal);
        setStatus("live");
        delay = FIRST_DELAY_MS;
        await readSseStream(
          body,
          (m) => {
            handle(m.data, m.id);
          },
          signal,
        );
      } catch (error) {
        if (isAuthError(error)) {
          setStatus("unauthorized");
          return;
        }
      }
      if (stopped()) break;
      setStatus("reconnecting");
      await sleep(delay, signal);
      delay = Math.min(delay * 2, MAX_DELAY_MS);
    }
    setStatus("closed");
  };
  void run();
  return () => {
    controller.abort();
  };
};
