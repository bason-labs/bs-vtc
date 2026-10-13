/**
 * An MCP SDK `Transport` over the socket's newline-delimited framing (`ENGINE_SOCKET`): exactly
 * MCP's stdio framing, after the hello/welcome lines the socket protocol adds (AD-12 rule 3). The
 * owner feeds it received lines (`receive`) and tells it when the peer has gone (`ended`). A line
 * that is not JSON, or not a JSON-RPC message, is answered with the JSON-RPC error and dropped.
 */
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  ErrorCode,
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import { encodeSocketLine } from "@vtc/shared";

export class LineTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private closed = false;

  constructor(
    private readonly write: (line: string) => void,
    private readonly end: () => void,
  ) {}

  start(): Promise<void> {
    return Promise.resolve();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if (!this.closed) this.write(encodeSocketLine(message));
    return Promise.resolve();
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.end();
      this.onclose?.();
    }
    return Promise.resolve();
  }

  /** One received line. */
  receive(line: string): void {
    if (this.closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      void this.send({
        jsonrpc: "2.0",
        id: null as unknown as string,
        error: { code: ErrorCode.ParseError, message: "parse error" },
      });
      return;
    }
    const parsed = JSONRPCMessageSchema.safeParse(raw);
    if (!parsed.success) {
      const id =
        typeof raw === "object" &&
        raw !== null &&
        (typeof (raw as { id?: unknown }).id === "string" ||
          typeof (raw as { id?: unknown }).id === "number")
          ? (raw as { id: string | number }).id
          : (null as unknown as string);
      void this.send({
        jsonrpc: "2.0",
        id,
        error: { code: ErrorCode.InvalidRequest, message: "invalid JSON-RPC message" },
      });
      return;
    }
    this.onmessage?.(parsed.data);
  }

  /** The peer closed the connection. */
  ended(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }
}
