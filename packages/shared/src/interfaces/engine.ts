/**
 * Engine composition seam (AD-19). Frozen here so three teams code against one shape:
 * - the engine-core team implements `runDaemon` and `serveSnapshot` (`@vtc/engine`, module
 *   `daemon/`);
 * - the gate-runner team implements `createGateRunner` (`@vtc/engine`, module `gates/`);
 * - the cli+binary team builds {@link EngineDeps} (storage driver, Gate Runner, adapters, asset
 *   bundle, timer) and calls them, and talks to a running daemon only through {@link EngineClient}.
 *
 * Transports: the Lead's host reaches the daemon through `vtc engine --mcp --host <host>` (stdio
 * bridge); the cli control commands (`vtc pause`, `resume`, `status`) are MCP clients of the same
 * daemon socket (`EngineDiscovery.mcp_socket`, protocol `ENGINE_SOCKET`). The HTTP API stays
 * read-only (AD-5).
 */
import type { z } from "zod";
import type { EngineMcpToolName, ENGINE_MCP_TOOLS, SessionNonceResult } from "../engine-api.js";
import type { EngineDiscovery } from "../engine-instance.js";
import type { CONTRACT_SCHEMAS } from "../json-schema.js";
import type { HostId } from "../primitives.js";
import type { AssetBundle } from "./assets.js";
import type { AutoResumeScheduler } from "./auto-resume.js";
import type { GateRunner } from "./gate-runner.js";
import type { HostAdapter } from "./host-adapter.js";
import type { StorageFactory } from "./storage.js";

export interface EngineVersions {
  readonly engine: string;
  readonly contracts: string;
}

/** Everything the daemon needs, injected by the cli (AD-1 rule 4). */
export interface EngineDeps {
  /** Absolute repo root (the daemon serves exactly one repo, AD-12). */
  readonly repoRoot: string;
  /** Absolute VTC home (`~/.vtc`): discovery, sockets, hidden tests. */
  readonly vtcHome: string;
  /**
   * The per-install token (AD-5 rule 2), read by the cli from `ENGINE_INSTANCE.tokenFile`. The
   * daemon checks bearer tokens against it and never reads or writes the token file itself.
   */
  readonly installToken: string;
  /** `node:sqlite` in dev/tests, `bun:sqlite` in the binary (AD-2). */
  readonly openStorage: StorageFactory;
  readonly gateRunner: GateRunner;
  /** One adapter per installed host. The engine never imports an implementation. */
  readonly adapters: Readonly<Partial<Record<HostId, HostAdapter>>>;
  /** The dashboard's static export (AD-2 rule 7). */
  readonly assets: AssetBundle;
  readonly scheduler: AutoResumeScheduler;
  readonly versions: EngineVersions;
  /** Clock override for tests. */
  readonly now?: () => Date;
}

export interface DaemonOptions {
  /** Started by the auto-resume timer (`vtc engine --daemon --wake`, AD-12 rule 4). */
  readonly wake: boolean;
}

/** A listening local server. */
export interface RunningServer {
  /** HTTP/SSE port on 127.0.0.1. */
  readonly port: number;
  /** The prototype server's port, or `null` (AD-5 rule 9). */
  readonly prototypePort: number | null;
  /** Resolves when the server has stopped (idle exit, `close`, or a fatal error). */
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface RunningDaemon extends RunningServer {
  /** What the daemon published to `~/.vtc/engines/<repo-key>.json`. */
  readonly discovery: EngineDiscovery;
}

/**
 * Takes the engine lock, opens the MCP socket and the HTTP server, publishes discovery, and runs
 * until idle (AD-12). Rejects with `EngineLockedError` when another daemon holds the repo.
 */
export type RunDaemon = (deps: EngineDeps, options: DaemonOptions) => Promise<RunningDaemon>;

/** What `vtc dashboard` needs without a running daemon (AD-5 rule 7). */
export interface SnapshotDeps {
  readonly repoRoot: string;
  readonly vtcHome: string;
  /** As in {@link EngineDeps}: the cli's install token, so `vtc` clients can read the snapshot. */
  readonly installToken: string;
  readonly assets: AssetBundle;
  readonly versions: EngineVersions;
  readonly now?: () => Date;
}

export interface RunningSnapshot extends RunningServer {
  /** Mints the single-use nonce `vtc dashboard` puts in the browser URL fragment. */
  mintNonce(): SessionNonceResult;
}

/** Serves the read routes from the committed `.vtc/` snapshot, read-only, without the lock. */
export type ServeSnapshot = (deps: SnapshotDeps) => Promise<RunningSnapshot>;

type ToolSpec<N extends EngineMcpToolName> = Extract<
  (typeof ENGINE_MCP_TOOLS)[number],
  { name: N }
>;

/** Input a caller sends to tool `N` (defaults may be omitted). */
export type EngineToolInput<N extends EngineMcpToolName> = z.input<
  (typeof CONTRACT_SCHEMAS)[ToolSpec<N>["input"]]
>;
/** Parsed output of tool `N`. */
export type EngineToolOutput<N extends EngineMcpToolName> = z.infer<
  (typeof CONTRACT_SCHEMAS)[ToolSpec<N>["output"]]
>;

/** An MCP client of a running daemon (the stdio bridge's upstream, the cli control commands). */
export interface EngineClient {
  call<N extends EngineMcpToolName>(
    tool: N,
    input: EngineToolInput<N>,
  ): Promise<EngineToolOutput<N>>;
  close(): Promise<void>;
}
