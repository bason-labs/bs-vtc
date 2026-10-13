import type { CommandSpec } from "./types.js";

/** Owner: gate-runner team (sub-project 2); spec §7.1. */
export const command: CommandSpec = {
  name: "calibrate",
  summary: "Detect the toolchain and freeze the gate baseline",
};
