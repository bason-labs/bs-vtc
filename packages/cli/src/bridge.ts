/**
 * `vtc engine --mcp --host <host>` (AD-12 rule 3; spine §5 reading proposed by the cli+binary
 * team): in a repo set up with `vtc init`, find or start the repo's daemon and relay bytes
 * (`mcp.runStdioBridge`). The plugins are user-scoped, so this bridge also runs in every repo a
 * host session opens; in a repo without `.vtc/project.yaml` it starts no daemon (a daemon creates
 * `.vtc/state/` in the user's repo) and answers MCP itself instead:
 * - `initialize`, `ping` and `tools/list` (the frozen tool list, so the host knows the tools);
 * - `tools/call` with a tool error that says to run `vtc init`, until the repo is set up. The
 *   first call after `vtc init` starts the daemon, replays the session's `initialize` to it
 *   (its answer is swallowed: the host already has one), and from then on relays bytes.
 * Messages are newline-delimited JSON-RPC, MCP's stdio framing (`ENGINE_SOCKET`).
 */
import type { Socket } from "node:net";
import type { Readable, Writable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { mcp } from "@vtc/engine";
import { CONTRACTS_VERSION, ENGINE_SOCKET, type HostId } from "@vtc/shared";

export interface BridgeOptions {
  readonly repoRoot: string;
  readonly host: HostId;
  readonly stdin: Readable;
  readonly stdout: Writable;
  /** True once `vtc init` set the repo up (`isVtcProject`). */
  readonly initialised: () => boolean;
  /** Finds or starts the repo's daemon; resolves its MCP socket path. */
  readonly daemonSocket: () => Promise<string>;
  /** `serverInfo.version` while the bridge answers by itself. */
  readonly serverVersion: string;
}

/** The id of the `initialize` the bridge replays to the daemon on switching over. */
const REPLAY_ID = "vtc-bridge-initialize";

type JsonRpcId = string | number | null;

interface Message {
  readonly id?: JsonRpcId;
  readonly method?: string;
  readonly params?: unknown;
}

const parse = (line: string): Message | null => {
  try {
    const raw: unknown = JSON.parse(line);
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? raw : null;
  } catch {
    return null;
  }
};

const encode = (message: unknown): string => `${JSON.stringify(message)}\n`;

/** The protocol version to answer: the client's when supported, else the newest. */
const negotiate = (params: unknown): string => {
  const requested =
    typeof params === "object" && params !== null
      ? (params as { protocolVersion?: unknown }).protocolVersion
      : undefined;
  return typeof requested === "string" && mcp.SUPPORTED_MCP_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : mcp.MCP_PROTOCOL_VERSION;
};

/** The bridge for `vtc engine --mcp`; resolves when either side closes. */
export const runBridge = async (options: BridgeOptions): Promise<void> => {
  if (options.initialised()) {
    await mcp.runStdioBridge({
      path: await options.daemonSocket(),
      host: options.host,
      stdin: options.stdin,
      stdout: options.stdout,
    });
    return;
  }
  await runDeferredBridge(options);
};

/** Waits for the daemon's answer to the replayed `initialize`; resolves the bytes after it. */
const replayedInitialize = (socket: Socket, forward: (line: string) => void): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = (): void => {
      socket.off("data", onData);
      socket.off("close", onClose);
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("the engine closed the connection during the MCP handshake"));
    };
    const onData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const at = buffer.indexOf(0x0a);
        if (at < 0) break;
        const line = buffer.subarray(0, at).toString("utf8");
        buffer = buffer.subarray(at + 1);
        if (parse(line)?.id === REPLAY_ID) {
          cleanup();
          resolve(buffer);
          return;
        }
        forward(`${line}\n`);
      }
      if (buffer.length > ENGINE_SOCKET.maxLineBytes) {
        cleanup();
        reject(new Error("the engine sent an overlong line"));
      }
    };
    socket.on("data", onData);
    socket.once("close", onClose);
  });

const runDeferredBridge = (options: BridgeOptions): Promise<void> =>
  new Promise((resolve) => {
    const { stdin, stdout } = options;
    const decoder = new StringDecoder("utf8");
    let partial = "";
    const queue: string[] = [];
    let busy = false;
    let finished = false;
    let initializeParams: unknown = undefined;

    let stdinEnded = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      resolve();
    };
    const reply = (id: JsonRpcId | undefined, body: Record<string, unknown>): void => {
      if (id !== undefined) stdout.write(encode({ jsonrpc: "2.0", id, ...body }));
    };
    const toolError = (id: JsonRpcId | undefined, text: string): void => {
      reply(id, {
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: text }) }],
          isError: true,
        },
      });
    };

    /** Starts the daemon and turns into a byte relay; the pending call is the first it gets. */
    const switchOver = async (pending: string): Promise<boolean> => {
      const { socket, rest } = await mcp.handshake(await options.daemonSocket(), {
        v: 1,
        client: "bridge",
        host: options.host,
        contracts_version: CONTRACTS_VERSION,
      });
      socket.on("error", () => socket.destroy());
      try {
        const answered = replayedInitialize(socket, (line) => stdout.write(line));
        if (rest.length > 0) socket.emit("data", rest);
        socket.write(
          encode({
            jsonrpc: "2.0",
            id: REPLAY_ID,
            method: "initialize",
            params: initializeParams ?? {
              protocolVersion: mcp.MCP_PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "vtc-bridge", version: options.serverVersion },
            },
          }),
        );
        const after = await answered;
        socket.write(encode({ jsonrpc: "2.0", method: "notifications/initialized" }));
        if (after.length > 0) stdout.write(after);
      } catch (error) {
        socket.destroy();
        throw error;
      }
      // from here on: plain bytes both ways, exactly as `mcp.runStdioBridge`
      finished = true;
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      socket.write(`${pending}\n`);
      for (const line of queue.splice(0)) socket.write(`${line}\n`);
      if (partial !== "") socket.write(partial);
      partial = "";
      socket.pipe(stdout, { end: false });
      socket.once("close", () => {
        stdin.unpipe(socket);
        resolve();
      });
      if (stdinEnded) {
        socket.end(); // the host closed stdin while the daemon started: let it answer, then close
      } else {
        stdin.pipe(socket);
        stdin.once("end", () => socket.destroy());
      }
      return true;
    };

    const handle = async (line: string): Promise<boolean> => {
      const message = parse(line);
      if (message === null) {
        reply(null, { error: { code: -32700, message: "Parse error" } });
        return false;
      }
      const { id, method } = message;
      if (typeof method !== "string") return false; // a response to us: we send no requests
      switch (method) {
        case "initialize":
          initializeParams = message.params;
          reply(id, {
            result: {
              protocolVersion: negotiate(message.params),
              capabilities: { tools: { listChanged: false } },
              serverInfo: { name: "vtc", version: options.serverVersion },
            },
          });
          return false;
        case "ping":
          reply(id, { result: {} });
          return false;
        case "tools/list":
          reply(id, { result: { tools: mcp.toolDefinitions() } });
          return false;
        case "tools/call":
          if (!options.initialised()) {
            toolError(
              id,
              `VTC is not set up in ${options.repoRoot}: ask the user to run \`vtc init\` in that repo, then call the tool again`,
            );
            return false;
          }
          try {
            return await switchOver(line);
          } catch (error) {
            toolError(
              id,
              `cannot reach the VTC engine: ${error instanceof Error ? error.message : String(error)}`,
            );
            return false;
          }
        default:
          if (method.startsWith("notifications/")) return false;
          reply(id, { error: { code: -32601, message: `Method not found: ${method}` } });
          return false;
      }
    };

    const drain = async (): Promise<void> => {
      if (busy) return;
      busy = true;
      try {
        while (!finished) {
          const line = queue.shift();
          if (line === undefined) break;
          if (await handle(line)) return;
        }
      } finally {
        busy = false;
      }
      if (stdinEnded && queue.length === 0) finish();
    };

    const onData = (chunk: Buffer | string): void => {
      partial += typeof chunk === "string" ? chunk : decoder.write(chunk);
      for (;;) {
        const at = partial.indexOf("\n");
        if (at < 0) break;
        const line = partial.slice(0, at).replace(/\r$/, "");
        partial = partial.slice(at + 1);
        if (line.trim() !== "") queue.push(line);
      }
      if (Buffer.byteLength(partial) > ENGINE_SOCKET.maxLineBytes) {
        finish();
        return;
      }
      void drain();
    };
    const onEnd = (): void => {
      stdinEnded = true;
      if (!busy) finish();
    };
    stdin.on("data", onData);
    stdin.once("end", onEnd);
  });
