import { pendingCommand } from "./types.js";

/** Owner: cli+binary team; scanner pins come from gates/ (gate-runner team). */
export const command = pendingCommand(
  "doctor",
  "Check prerequisites; download pinned browsers and scanners",
);
