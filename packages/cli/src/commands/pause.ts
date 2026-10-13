import type { CommandSpec } from "./types.js";

/** Owner: cli+binary team; calls the engine (spec §6.7 guardrails). */
export const command: CommandSpec = {
  name: "pause",
  summary: "Kill switch: stop dispatching and merging",
};
