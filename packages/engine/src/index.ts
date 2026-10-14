/**
 * @vtc/engine: the deterministic core (§4.1). Depends on @vtc/shared only; host adapters, the
 * storage driver, the Gate Runner, the asset bundle and the auto-resume timer are injected by the
 * cli (AD-1, AD-2, AD-19). Owned by the integrator (AD-15): each module exposes its API through
 * its own `index.ts` (AD-13) under its own namespace, so two teams' export names can never
 * collide here and teams never need to edit this file.
 */
import {
  CONTRACTS_VERSION,
  ENGINE_MCP_TOOLS,
  type EngineMcpToolName,
  type StorageFactory,
} from "@vtc/shared";

export * as core from "./core/index.js";
export * as gates from "./gates/index.js";
export * as git from "./git/index.js";
export * as http from "./http/index.js";
export * as lookback from "./lookback/index.js";
export * as mcp from "./mcp/index.js";
export * as research from "./research/index.js";
export { runDaemon, serveSnapshot } from "./daemon/index.js";

export const ENGINE_NAME = "vtc-engine";

/** Contracts version this engine was built against. */
export const ENGINE_CONTRACTS_VERSION = CONTRACTS_VERSION;

/** MCP tool names this engine serves (implemented in sub-project 1). */
export const engineToolNames = (): EngineMcpToolName[] => ENGINE_MCP_TOOLS.map((tool) => tool.name);

/**
 * Loads the `node:sqlite` driver on demand (AD-2). Drivers are never imported eagerly, so the
 * Bun binary never evaluates `node:sqlite` and Node never evaluates `bun:sqlite`.
 */
export const loadNodeSqliteStorage = async (): Promise<StorageFactory> =>
  (await import("./storage/node-sqlite.js")).openNodeSqlite;

/** Loads the `bun:sqlite` driver on demand. Only valid under the Bun runtime (the binary). */
export const loadBunSqliteStorage = async (): Promise<StorageFactory> =>
  (await import("./storage/bun-sqlite.js")).openBunSqlite;
