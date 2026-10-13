import { pendingCommand } from "./types.js";

/** Owner: cli+binary team. Calls the `status` tool through `ctx.engine()` (AD-19). */
export const command = pendingCommand("status", "Show the current run");
