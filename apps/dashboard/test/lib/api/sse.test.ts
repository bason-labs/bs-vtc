import { describe, expect, it } from "vitest";
import { createSseParser, readSseStream, type SseMessage } from "@/lib/api/sse";

const collect = (chunks: string[]): SseMessage[] => {
  const out: SseMessage[] = [];
  const parser = createSseParser((m) => out.push(m));
  for (const c of chunks) parser.push(c);
  return out;
};

describe("createSseParser", () => {
  it("dispatches a message on a blank line, with its id", () => {
    expect(collect(['id: golden-1:3\ndata: {"seq":3}\n\n'])).toEqual([
      { id: "golden-1:3", event: "message", data: '{"seq":3}' },
    ]);
  });

  it("joins multi-line data with newlines and handles CRLF", () => {
    expect(collect(["data: a\r\ndata: b\r\n\r\n"])).toEqual([
      { id: null, event: "message", data: "a\nb" },
    ]);
  });

  it("buffers across chunk boundaries, including a split CRLF", () => {
    expect(collect(["id: r:1\nda", "ta: x\r", "\n\r\n"])).toEqual([
      { id: "r:1", event: "message", data: "x" },
    ]);
  });

  it("ignores comments, unknown fields and blocks without data", () => {
    expect(collect([": keep-alive\n\nretry: 10\nfoo: bar\n\nevent: ping\n\n"])).toEqual([]);
  });

  it("keeps the event name and strips only one leading space", () => {
    expect(collect(["event: usage\ndata:  two spaces\n\n"])).toEqual([
      { id: null, event: "usage", data: " two spaces" },
    ]);
  });

  it("does not dispatch an unterminated block", () => {
    expect(collect(["data: half"])).toEqual([]);
  });
});

describe("readSseStream", () => {
  it("decodes a byte stream into messages", async () => {
    const bytes = new TextEncoder().encode("id: r:1\ndata: é\n\nid: r:2\ndata: z\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, 13));
        controller.enqueue(bytes.slice(13));
        controller.close();
      },
    });
    const out: SseMessage[] = [];
    await readSseStream(body, (m) => out.push(m));
    expect(out.map((m) => [m.id, m.data])).toEqual([
      ["r:1", "é"],
      ["r:2", "z"],
    ]);
  });
});
