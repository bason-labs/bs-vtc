/**
 * The daemon's local MCP socket (AD-12 rule 3, AD-19 rule 4): `~/.vtc/run/<repo-key>.sock`
 * (directory 0700, socket 0600). Every connection opens with one `EngineSocketHello` line and one
 * `EngineSocketWelcome` line; a malformed hello or another contracts MAJOR gets `ok: false` and the
 * connection is closed. After that the connection is plain MCP, served by the official SDK's
 * server over {@link LineTransport}; each connection is its own MCP session (`CallContext.session`).
 * Never exposed over HTTP.
 *
 * Human channel (D-an, spine §5 reading 71): a cli hello may carry the install token, which the
 * cli sends only for a human-only tool after a TTY confirmation. It is compared in constant time
 * with the daemon's; a mismatch refuses the connection, a match marks every call of the
 * connection `CallContext.human`. A bridge's `session_sandbox` report is passed on per call
 * (`CallContext.sessionSandbox`) for the engine to keep as its run's Lead session's.
 */
import { createHash, timingSafeEqual } from "node:crypto";
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
import { createMcpServer, type ToolHost } from "./server.js";
import { LineTransport } from "./transport.js";

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
  /** The per-install token (`EngineDeps.installToken`) a cli hello's `install_token` must match. */
  readonly installToken: string;
  /** Called whenever a connection opens or closes (the daemon's idle timer). */
  readonly onActivity?: () => void;
}

/** Constant-time equality of two secrets of any length (digests are compared, not the bytes). */
const sameSecret = (a: string, b: string): boolean =>
  timingSafeEqual(
    createHash("sha256").update(a, "utf8").digest(),
    createHash("sha256").update(b, "utf8").digest(),
  );

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
  let sessions = 0;
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    sessions += 1;
    const session = `s${String(sessions)}`;
    let hello: EngineSocketHello | null = null;
    // After a refused hello (`ok: false`, then close, AD-12 rule 3) no further line is read.
    let rejected = false;
    const sendLine = (message: unknown): void => {
      if (!socket.destroyed) socket.write(encodeSocketLine(message));
    };
    const transport = new LineTransport(
      (line) => {
        if (!socket.destroyed) socket.write(line);
      },
      () => socket.end(),
    );
    const refuse = (reason: string): void => {
      rejected = true;
      sendLine(welcome(options.versions, reason));
      socket.end();
    };
    const reader = createLineReader(ENGINE_SOCKET.maxLineBytes, (line) => {
      if (rejected) return;
      if (hello === null) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          raw = undefined;
        }
        const parsed = EngineSocketHelloSchema.safeParse(raw);
        if (!parsed.success) {
          refuse("malformed hello: expected an EngineSocketHello line");
          return;
        }
        if (!contractsCompatible(parsed.data.contracts_version, options.versions.contracts)) {
          refuse(
            `contracts ${parsed.data.contracts_version} are incompatible with ${options.versions.contracts}`,
          );
          return;
        }
        const token = parsed.data.install_token;
        if (token !== undefined && !sameSecret(token, options.installToken)) {
          refuse("the install token does not match this engine's");
          return;
        }
        hello = parsed.data;
        counts[hello.client] += 1;
        options.onActivity?.();
        sendLine(welcome(options.versions));
        void createMcpServer(options.host, {
          call: {
            host: hello.host,
            session,
            client: hello.client,
            ...(token === undefined ? {} : { human: true }),
            ...(hello.session_sandbox === undefined
              ? {}
              : { sessionSandbox: hello.session_sandbox }),
          },
          serverVersion: options.versions.engine,
        }).connect(transport);
        return;
      }
      transport.receive(line);
    });
    socket.on("data", (chunk: Buffer) => {
      if (!reader.push(chunk)) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      sockets.delete(socket);
      transport.ended();
      if (hello !== null) {
        counts[hello.client] -= 1;
        options.host.sessionClosed?.(session);
      }
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
