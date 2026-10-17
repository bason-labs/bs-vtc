/**
 * Clients of the daemon's socket (AD-12 rule 3, AD-19 rule 4): the typed `EngineClient` the cli's
 * control commands use (`client: cli`), and the stdio bridge `vtc engine --mcp --host <host>`
 * (`client: bridge`), which sends its hello, reads the welcome and then copies bytes both ways
 * without parsing them.
 */
import { connect, type Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
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
  type SessionSandboxState,
} from "@vtc/shared";
import { createLineReader } from "./lines.js";
import { LineTransport } from "./transport.js";

/** Engine calls can run long (a resume sweeps the checkout; gates run in jobs, not calls). */
const CALL_TIMEOUT_MS = 10 * 60_000;

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

/** How long {@link engineSocketAnswers} waits for a welcome. */
export const SOCKET_PROBE_TIMEOUT_MS = 3_000;

/**
 * True when an engine answers the hello on `path` within the timeout: any well-formed welcome,
 * a refusal (`ok: false`, another contracts MAJOR) included, means the holder lives. A refused
 * connection, a missing path, a close, a malformed line or silence is `false`. Used by the lock's
 * stale check (AD-12 rule 1, spine §5 reading 67); never throws.
 */
export const engineSocketAnswers = (
  path: string,
  options: { readonly timeoutMs?: number; readonly contractsVersion?: string } = {},
): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    const socket = connect(path);
    const done = (answer: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(answer);
    };
    const timer = setTimeout(() => {
      done(false);
    }, options.timeoutMs ?? SOCKET_PROBE_TIMEOUT_MS);
    socket.on("error", () => {
      done(false);
    });
    socket.on("close", () => {
      done(false);
    });
    socket.once("connect", () => {
      const hello: EngineSocketHello = {
        v: 1,
        client: "cli",
        host: null,
        contracts_version: options.contractsVersion ?? CONTRACTS_VERSION,
      };
      socket.write(encodeSocketLine(hello));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const at = buffer.indexOf(0x0a);
      if (at < 0) {
        if (buffer.length > ENGINE_SOCKET.maxLineBytes) done(false);
        return;
      }
      try {
        const line: unknown = JSON.parse(buffer.subarray(0, at).toString("utf8"));
        done(EngineSocketWelcomeSchema.safeParse(line).success);
      } catch {
        done(false);
      }
    });
  });

/**
 * The cli's typed client (`EngineClient`): `call(tool, input)` with per-tool types, on the SDK's
 * client. `bridge` connects as a host's bridge session instead (tests and tooling that act as a
 * Lead or a role session), reporting `sessionSandbox` when given. `installToken` (cli only) makes
 * the connection a human channel for the human-only tools (D-an, spine §5 reading 71): the cli
 * passes it only after the human confirmed in an interactive terminal, and only to a daemon of
 * contracts 4.3.0 or later (an older one refuses the field).
 */
export const connectEngineClient = async (
  path: string,
  contractsVersion = CONTRACTS_VERSION,
  options: {
    readonly bridge?: HostId;
    readonly sessionSandbox?: SessionSandboxState;
    readonly installToken?: string;
  } = {},
): Promise<EngineClient> => {
  const { socket, rest } = await handshake(
    path,
    options.bridge === undefined
      ? {
          v: 1,
          client: "cli",
          host: null,
          contracts_version: contractsVersion,
          ...(options.installToken === undefined ? {} : { install_token: options.installToken }),
        }
      : {
          v: 1,
          client: "bridge",
          host: options.bridge,
          contracts_version: contractsVersion,
          ...(options.sessionSandbox === undefined
            ? {}
            : { session_sandbox: options.sessionSandbox }),
        },
  );
  const transport = new LineTransport(
    (line) => {
      if (!socket.destroyed) socket.write(line);
    },
    () => socket.end(),
  );
  const reader = createLineReader(ENGINE_SOCKET.maxLineBytes, (line) => {
    transport.receive(line);
  });
  socket.on("data", (chunk: Buffer) => {
    if (!reader.push(chunk)) socket.destroy();
  });
  const closed = new Promise<void>((resolve) => {
    socket.once("close", () => {
      transport.ended();
      resolve();
    });
  });
  socket.on("error", () => socket.destroy());
  if (rest.length > 0) reader.push(rest);
  const client = new Client({ name: "vtc-cli", version: contractsVersion }, { capabilities: {} });
  try {
    await client.connect(transport, { timeout: CALL_TIMEOUT_MS });
  } catch (error) {
    socket.destroy();
    throw new EngineConnectError(
      `the engine did not complete the MCP handshake: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    call: async <N extends EngineMcpToolName>(
      tool: N,
      input: unknown,
    ): Promise<EngineToolOutput<N>> => {
      const spec = ENGINE_MCP_TOOLS.find((t) => t.name === tool);
      if (spec === undefined) throw new Error(`unknown tool ${tool}`);
      const result = await client.callTool(
        { name: tool, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      );
      if (result.isError === true) {
        const content = result.content as { text?: string }[] | undefined;
        throw new Error(content?.[0]?.text ?? `${tool} failed`);
      }
      return CONTRACT_SCHEMAS[spec.output].parse(result.structuredContent) as EngineToolOutput<N>;
    },
    close: async () => {
      if (!socket.destroyed) socket.end();
      await closed;
    },
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
  /** The host session's sandbox state (D-an), e.g. from `claudeSessionSandboxState`. */
  readonly sessionSandbox?: SessionSandboxState;
}): Promise<void> => {
  const { socket, rest } = await handshake(options.path, {
    v: 1,
    client: "bridge",
    host: options.host,
    contracts_version: options.contractsVersion ?? CONTRACTS_VERSION,
    ...(options.sessionSandbox === undefined ? {} : { session_sandbox: options.sessionSandbox }),
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
