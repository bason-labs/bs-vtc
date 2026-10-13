import type { CommandSpec } from "./types.js";

/** Owner: engine-core team (daemon) and cli+binary team (bridge); AD-12. */
export const command: CommandSpec = {
  name: "engine",
  summary: "Run the engine daemon (--daemon) or the stdio MCP bridge (--mcp)",
};
