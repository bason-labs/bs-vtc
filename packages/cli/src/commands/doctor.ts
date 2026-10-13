import type { CommandSpec } from "./types.js";

/** Owner: cli+binary team; scanner pins come from gates/ (gate-runner team). */
export const command: CommandSpec = {
  name: "doctor",
  summary: "Check prerequisites; download pinned browsers and scanners",
};
