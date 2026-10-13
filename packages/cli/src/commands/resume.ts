import { pendingCommand } from "./types.js";

/** Owner: cli+binary team. Calls the `resume` tool through `ctx.engine()` (spec §6.8, AD-19). */
export const command = pendingCommand("resume", "Resume a paused or interrupted run");
