import { pendingCommand } from "./types.js";

/** Owner: cli+binary team. An MCP client of the daemon: calls the `pause` tool through `ctx.engine()` (spec §6.7 guardrails, AD-19). */
export const command = pendingCommand("pause", "Kill switch: stop dispatching and merging");
