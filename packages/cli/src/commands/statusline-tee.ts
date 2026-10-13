import type { CommandSpec } from "./types.js";

/**
 * Owner: cli+binary team. The Claude statusline tee shim (§6.9): runs the user's own statusline
 * command unchanged, and forwards `statuslineIngestFromClaude(stdin)` to the running engine
 * found through the discovery file (AD-12). The Claude adapter's `install` wires it in.
 */
export const command: CommandSpec = {
  name: "statusline-tee",
  summary: "Claude statusline shim: show the user's statusline, forward usage to the engine",
};
