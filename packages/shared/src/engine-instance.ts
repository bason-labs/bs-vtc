/**
 * Engine instance model (AD-12): one engine daemon per repo, found through a discovery file.
 * Shared so the cli (bridge, dashboard, statusline shim) and the engine agree on paths and shape.
 */
import { z } from "zod";
import { sha256Hex } from "./helpers/fingerprint.js";
import { IsoDateTimeSchema } from "./primitives.js";

export const ENGINE_INSTANCE = {
  /** Exclusive lock, repo-relative; held by the single writer of the event log. */
  lockFile: ".vtc/state/engine.lock",
  /** Discovery directory under the VTC home (`~/.vtc`). Files are mode 0600. */
  discoveryDir: "engines",
  /**
   * Directory under the VTC home for the daemons' MCP sockets (mode 0700). Not `.vtc/state/`:
   * a Unix socket path must fit `sun_path` (104 bytes on macOS, 108 on Linux), and repo paths
   * can be arbitrarily deep.
   */
  socketDir: "run",
  /** A daemon with no runs to drive, no bridges and nothing scheduled exits after this long. */
  idleExitMs: 30 * 60 * 1000,
} as const;

/** Normalises an absolute repo root: POSIX separators, no trailing slash. */
export const normalizeRepoRoot = (absPath: string): string => {
  const posix = absPath.replace(/\\/g, "/");
  const trimmed = posix.length > 1 ? posix.replace(/\/+$/, "") : posix;
  if (!(trimmed.startsWith("/") || /^[A-Za-z]:\//.test(trimmed))) {
    throw new TypeError(`repo root must be absolute, got ${absPath}`);
  }
  return trimmed;
};

/** Stable key of a repo: first 16 hex chars of SHA-256 of its normalised absolute root. */
export const engineRepoKey = (absRepoRoot: string): string =>
  sha256Hex(normalizeRepoRoot(absRepoRoot)).slice(0, 16);

/** Discovery file name for a repo, relative to `~/.vtc/`. */
export const engineDiscoveryFile = (absRepoRoot: string): string =>
  `${ENGINE_INSTANCE.discoveryDir}/${engineRepoKey(absRepoRoot)}.json`;

/** Longest Unix socket path VTC binds, in bytes (below macOS's 104-byte `sun_path`). */
export const UNIX_SOCKET_MAX_BYTES = 100;

/** The daemon's MCP socket, relative to `~/.vtc/`: `run/<repo-key>.sock` (25 bytes). */
export const engineSocketFile = (absRepoRoot: string): string =>
  `${ENGINE_INSTANCE.socketDir}/${engineRepoKey(absRepoRoot)}.sock`;

/** The daemon's named pipe on Windows: `\\.\pipe\vtc-<repo-key>`. */
export const engineWindowsPipe = (absRepoRoot: string): string =>
  `\\\\.\\pipe\\vtc-${engineRepoKey(absRepoRoot)}`;

/** True when a Unix socket path fits {@link UNIX_SOCKET_MAX_BYTES}; the daemon refuses to start otherwise. */
export const fitsUnixSocketPath = (absPath: string): boolean =>
  new TextEncoder().encode(absPath).length <= UNIX_SOCKET_MAX_BYTES;

/**
 * `~/.vtc/engines/<repo-key>.json`, written by the running daemon (mode 0600) and removed on a
 * clean exit. It holds no secret: clients read the token from `~/.vtc/token` (AD-5).
 */
export const EngineDiscoverySchema = z.strictObject({
  v: z.literal(1),
  pid: z.int().positive(),
  /** HTTP/SSE port on 127.0.0.1 (AD-5). */
  port: z.int().min(1).max(65535),
  /** The separate prototype server's port (AD-5 rule 9), or `null` when not started. */
  prototype_port: z.int().min(1).max(65535).nullable(),
  /**
   * Local MCP endpoint the stdio bridges and the cli control commands connect to: the Unix
   * socket `~/.vtc/run/<repo-key>.sock` or the Windows pipe `\\.\pipe\vtc-<repo-key>`.
   */
  mcp_socket: z.string().min(1).max(1024),
  repo_root: z.string().min(1).max(4096),
  started_at: IsoDateTimeSchema,
  engine_version: z.string().min(1).max(64),
  contracts_version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type EngineDiscovery = z.infer<typeof EngineDiscoverySchema>;
