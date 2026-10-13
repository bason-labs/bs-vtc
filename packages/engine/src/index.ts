/**
 * @vtc/engine: the deterministic core (§4.1). Depends on @vtc/shared only; host adapters and
 * the storage driver are injected by the cli (AD-1, AD-2).
 */
import {
  CONTRACTS_VERSION,
  ENGINE_MCP_TOOLS,
  type EngineMcpToolName,
  type StorageFactory,
} from "@vtc/shared";

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
