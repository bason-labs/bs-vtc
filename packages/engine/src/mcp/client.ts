/**
 * Clients of the daemon's socket (AD-12 rule 3, AD-19 rule 4): the typed `EngineClient` the cli's
 * control commands use (`client: cli`), and the stdio bridge `vtc engine --mcp --host <host>`
 * (`client: bridge`), which sends its hello, reads the welcome and then copies bytes both ways
 * without parsing them.
 */
import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import {
  CONTRACT_SCHEMAS,
  CONTRACTS_VERSION,
  encodeSocketLine,
  ENGINE_MCP_TOOLS,
  ENGINE_SOCKET,
  EngineSocketWelcomeSchema,
  type EngineClient,
  type EngineMcpToolName,
  type EngineSocketHello,
  type EngineSocketWelcome,
  type EngineToolOutput,
  type HostId,
} from "@vtc/shared";
import { createLineReader } from "./lines.js";
import { MCP_PROTOCOL_VERSION } from "./server.js";

export class EngineConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineConnectError";
  }
}

/** Connects and completes the hello/welcome handshake; resolves with the socket and leftover bytes. */
export const handshake = (
  path: string,
  hello: EngineSocketHello,
): Promise<{ socket: Socket; welcome: EngineSocketWelcome; rest: Buffer }> =>
  new Promise((resolve, reject) => {
    const socket = connect(path);
    let buffer = Buffer.alloc(0);
    const fail = (error: Error): void => {
      socket.destroy();
      reject(error);
    };
    socket.once("error", (error) => {
      fail(new EngineConnectError(`cannot reach the engine at ${path}: ${error.message}`));
    });
    socket.once("connect", () => socket.write(encodeSocketLine(hello)));
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf(0x0a);
      if (at < 0) {
        if (buffer.length > ENGINE_SOCKET.maxLineBytes)
          fail(new EngineConnectError("the welcome line is too long"));
        return;
      }
      socket.off("data", onData);
      let raw: unknown;
      try {
        raw = JSON.parse(buffer.subarray(0, at).toString("utf8"));
      } catch {
        fail(new EngineConnectError("the engine sent a malformed welcome"));
        return;
      }
      const parsed = EngineSocketWelcomeSchema.safeParse(raw);
      if (!parsed.success) {
        fail(new EngineConnectError("the engine sent a malformed welcome"));
        return;
      }
      if (!parsed.data.ok) {
        fail(
          new EngineConnectError(
            `the engine refused the connection: ${parsed.data.error ?? "unknown error"}`,
          ),
        );
        return;
      }
      socket.removeAllListeners("error");
      resolve({ socket, welcome: parsed.data, rest: buffer.subarray(at + 1) });
    };
    socket.on("data", onData);
  });

interface Pending {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** The cli's typed client (`EngineClient`): `call(tool, input)` with per-tool types. */
export const connectEngineClient = async (
  path: string,
  contractsVersion = CONTRACTS_VERSION,
): Promise<EngineClient> => {
  const { socket, rest } = await handshake(path, {
    v: 1,
    client: "cli",
    host: null,
    contracts_version: contractsVersion,
  });
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const request = (method: string, params: unknown): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextId;
      nextId += 1;
      pending.set(id, { resolve, reject });
      socket.write(encodeSocketLine({ jsonrpc: "2.0", id, method, params }));
    });
  const reader = createLineReader(ENGINE_SOCKET.maxLineBytes, (line) => {
    let message: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (waiter === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined)
      waiter.reject(new Error(message.error.message ?? "engine error"));
    else waiter.resolve(message.result);
  });
  const failAll = (error: Error): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  socket.on("data", (chunk: Buffer) => {
    if (!reader.push(chunk)) socket.destroy();
  });
  socket.on("close", () => {
    failAll(new EngineConnectError("the engine closed the connection"));
  });
  socket.on("error", (error) => {
    failAll(new EngineConnectError(error.message));
  });
  if (rest.length > 0) reader.push(rest);
  await request("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "vtc-cli", version: contractsVersion },
  });
  socket.write(encodeSocketLine({ jsonrpc: "2.0", method: "notifications/initialized" }));
  return {
    call: async <N extends EngineMcpToolName>(
      tool: N,
      input: unknown,
    ): Promise<EngineToolOutput<N>> => {
      const spec = ENGINE_MCP_TOOLS.find((t) => t.name === tool);
      if (spec === undefined) throw new Error(`unknown tool ${tool}`);
      const result = (await request("tools/call", { name: tool, arguments: input })) as {
        isError?: boolean;
        structuredContent?: unknown;
        content?: { text?: string }[];
      };
      if (result.isError === true) {
        throw new Error(result.content?.[0]?.text ?? `${tool} failed`);
      }
      return CONTRACT_SCHEMAS[spec.output].parse(result.structuredContent) as EngineToolOutput<N>;
    },
    close: () =>
      new Promise<void>((resolve) => {
        if (socket.destroyed) {
          resolve();
          return;
        }
        socket.once("close", () => {
          resolve();
        });
        socket.end();
      }),
  };
};

/**
 * The stdio bridge (`vtc engine --mcp --host <host>`, AD-12 rule 3): hello, welcome, then bytes
 * copied both ways unparsed. Resolves when either side closes.
 */
export const runStdioBridge = async (options: {
  readonly path: string;
  readonly host: HostId;
  readonly stdin: Readable;
  readonly stdout: Writable;
  readonly contractsVersion?: string;
}): Promise<void> => {
  const { socket, rest } = await handshake(options.path, {
    v: 1,
    client: "bridge",
    host: options.host,
    contracts_version: options.contractsVersion ?? CONTRACTS_VERSION,
  });
  if (rest.length > 0) options.stdout.write(rest);
  options.stdin.pipe(socket);
  socket.pipe(options.stdout, { end: false });
  await new Promise<void>((resolve) => {
    const done = (): void => {
      options.stdin.unpipe(socket);
      socket.destroy();
      resolve();
    };
    socket.once("close", done);
    options.stdin.once("end", done);
  });
};
