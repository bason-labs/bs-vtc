import { pendingCommand } from "./types.js";

/**
 * Owner: cli+binary team (AD-12, AD-19). `--daemon [--wake]` builds `EngineDeps` (`wiring.ts`)
 * and calls `runDaemon` from @vtc/engine, which the engine-core team implements inside the engine
 * package; `--mcp --host <host>` is the stdio bridge to the daemon's local socket, the MCP
 * entry of every host plugin (AD-16).
 */
export const command = pendingCommand(
  "engine",
  "Run the engine daemon (--daemon) or the stdio MCP bridge (--mcp --host <host>)",
);
