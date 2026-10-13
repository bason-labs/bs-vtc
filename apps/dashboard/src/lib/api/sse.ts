/**
 * Server-sent events over `fetch` (AD-5 rule 2: EventSource cannot send the bearer header). A
 * minimal parser of the `text/event-stream` format: `id`, `event` and `data` fields, comments,
 * CR/LF/CRLF line ends, dispatch on a blank line. `retry` and unknown fields are ignored.
 */
export interface SseMessage {
  /** The `id:` field (`<run>:<seq>` from the engine), or `null` when the block had none. */
  readonly id: string | null;
  readonly event: string;
  readonly data: string;
}

export interface SseParser {
  push(chunk: string): void;
}

export const createSseParser = (onMessage: (message: SseMessage) => void): SseParser => {
  let buffer = "";
  let id: string | null = null;
  let event = "";
  let data: string[] = [];
  let sawData = false;

  const dispatch = (): void => {
    if (sawData) onMessage({ id, event: event === "" ? "message" : event, data: data.join("\n") });
    id = null;
    event = "";
    data = [];
    sawData = false;
  };

  const line = (text: string): void => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon === -1 ? text : text.slice(0, colon);
    let value = colon === -1 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      data.push(value);
      sawData = true;
    } else if (field === "id") {
      id = value;
    } else if (field === "event") {
      event = value;
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      for (;;) {
        const match = /\r\n|\r|\n/.exec(buffer);
        if (match === null) return;
        // A lone CR at the end may be the first half of a CRLF split across chunks.
        if (match[0] === "\r" && match.index === buffer.length - 1) return;
        line(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    },
  };
};

/** Reads a response body to the end (or until `signal` aborts), passing each message on. */
export const readSseStream = async (
  body: ReadableStream<Uint8Array>,
  onMessage: (message: SseMessage) => void,
  signal?: AbortSignal,
): Promise<void> => {
  const parser = createSseParser(onMessage);
  const decoder = new TextDecoder();
  const reader = body.getReader();
  const cancel = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
};
