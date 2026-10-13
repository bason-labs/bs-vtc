import { pendingCommand } from "./types.js";

/** Owner: gate-runner team (sub-project 2); spec §7.1. Builds the Gate Runner with `gates.createGateRunner` (AD-19). */
export const command = pendingCommand(
  "calibrate",
  "Detect the toolchain and freeze the gate baseline",
);
