/**
 * The daemon's local MCP socket (AD-12 rule 3, AD-19 rule 4): `~/.vtc/run/<repo-key>.sock`
 * (directory 0700, socket 0600). Every connection opens with one `EngineSocketHello` line and one
 * `EngineSocketWelcome` line; a malformed hello or another contracts MAJOR gets `ok: false` and the
 * connection is closed. After that the connection is plain MCP. Never exposed over HTTP.
 */
import { chmodSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";
import {
  contractsCompatible,
  encodeSocketLine,
  ENGINE_SOCKET,
  EngineSocketHelloSchema,
  fitsUnixSocketPath,
  type EngineSocketHello,
  type EngineSocketWelcome,
  type EngineVersions,
} from "@vtc/shared";
import { createLineReader } from "./lines.js";
import { createMcpSession, RPC_ERRORS, type ToolHost } from "./server.js";

export class SocketPathTooLongError extends Error {
  constructor(readonly path: string) {
    super(`the MCP socket path is longer than the platform allows: ${path}`);
    this.name = "SocketPathTooLongError";
  }
}

export interface EngineSocketServer {
  readonly path: string;
  /** Open connections whose hello was accepted, by client kind (bridges keep the daemon up). */
  connections(): { readonly bridge: number; readonly cli: number };
  close(): Promise<void>;
}

export interface EngineSocketOptions {
  readonly path: string;
  readonly host: ToolHost;
  readonly versions: EngineVersions;
  /** Called whenever a connection opens or closes (the daemon's idle timer). */
  readonly onActivity?: () => void;
}

const welcome = (versions: EngineVersions, error?: string): EngineSocketWelcome => ({
  v: 1,
  ok: error === undefined,
  engine_version: versions.engine,
  contracts_version: versions.contracts,
  ...(error === undefined ? {} : { error: error.slice(0, 500) }),
});

/** Listens on the socket. Rejects when the path does not fit `sun_path` (AD-12 rule 3). */
export const serveEngineSocket = async (
  options: EngineSocketOptions,
): Promise<EngineSocketServer> => {
  const isPipe = options.path.startsWith("\\\\.\\pipe\\");
  if (!isPipe) {
    if (!fitsUnixSocketPath(options.path)) throw new SocketPathTooLongError(options.path);
    mkdirSync(dirname(options.path), { recursive: true, mode: 0o700 });
    chmodSync(dirname(options.path), 0o700);
    // The caller holds the engine lock, so a leftover socket file belongs to a dead daemon.
    if (existsSync(options.path)) unlinkSync(options.path);
  }
  const counts = { bridge: 0, cli: 0 };
  const sockets = new Set<Socket>();
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let hello: EngineSocketHello | null = null;
    let queue = Promise.resolve();
    const send = (message: unknown): void => {
      if (!socket.destroyed) socket.write(encodeSocketLine(message));
    };
    const reader = createLineReader(ENGINE_SOCKET.maxLineBytes, (line) => {
      if (hello === null) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          raw = undefined;
        }
        const parsed = EngineSocketHelloSchema.safeParse(raw);
        if (!parsed.success) {
          send(welcome(options.versions, "malformed hello: expected an EngineSocketHello line"));
          socket.end();
          return;
        }
        if (!contractsCompatible(parsed.data.contracts_version, options.versions.contracts)) {
          send(
            welcome(
              options.versions,
              `contracts ${parsed.data.contracts_version} are incompatible with ${options.versions.contracts}`,
            ),
          );
          socket.end();
          return;
        }
        hello = parsed.data;
        counts[hello.client] += 1;
        options.onActivity?.();
        send(welcome(options.versions));
        return;
      }
      const session = sessionFor(hello);
      queue = queue.then(async () => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          send({
            jsonrpc: "2.0",
            id: null,
            error: { code: RPC_ERRORS.parse, message: "parse error" },
          });
          return;
        }
        const response = await session.handle(message);
        if (response !== null) send(response);
      });
    });
    const sessions = new Map<EngineSocketHello, ReturnType<typeof createMcpSession>>();
    const sessionFor = (h: EngineSocketHello) => {
      let s = sessions.get(h);
      if (s === undefined) {
        s = createMcpSession(options.host, {
          host: h.host,
          serverVersion: options.versions.engine,
        });
        sessions.set(h, s);
      }
      return s;
    };
    socket.on("data", (chunk: Buffer) => {
      if (!reader.push(chunk)) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      if (hello !== null) counts[hello.client] -= 1;
      options.onActivity?.();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.path, () => {
      server.off("error", reject);
      resolve();
    });
  });
  if (!isPipe) chmodSync(options.path, 0o600);
  return {
    path: options.path,
    connections: () => ({ ...counts }),
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => {
          if (!isPipe && existsSync(options.path)) {
            try {
              unlinkSync(options.path);
            } catch {
              // already gone
            }
          }
          resolve();
        });
      }),
  };
};
