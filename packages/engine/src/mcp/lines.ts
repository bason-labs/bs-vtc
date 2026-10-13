/**
 * Newline-delimited framing (`ENGINE_SOCKET`): one JSON-RPC message per line, exactly MCP's stdio
 * framing. A line longer than `maxLineBytes` closes the connection.
 */
import { StringDecoder } from "node:string_decoder";

export interface LineReader {
  /** Feed bytes; returns false when the line limit was exceeded (close the connection). */
  push(chunk: Buffer): boolean;
}

export const createLineReader = (
  maxLineBytes: number,
  onLine: (line: string) => void,
): LineReader => {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  return {
    push: (chunk) => {
      pending += decoder.write(chunk);
      for (;;) {
        const at = pending.indexOf("\n");
        if (at < 0) break;
        const line = pending.slice(0, at).replace(/\r$/, "");
        pending = pending.slice(at + 1);
        if (Buffer.byteLength(line) > maxLineBytes) return false;
        if (line.trim() !== "") onLine(line);
      }
      return Buffer.byteLength(pending) <= maxLineBytes;
    },
  };
};
