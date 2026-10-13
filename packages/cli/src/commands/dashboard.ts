import type { CommandSpec } from "./types.js";

/** Owner: cli+binary team; opens the running engine's dashboard, or serves the committed .vtc/ snapshot read-only (AD-12). */
export const command: CommandSpec = {
  name: "dashboard",
  summary: "Serve Flow Studio on 127.0.0.1 (live engine, or a read-only snapshot)",
};
