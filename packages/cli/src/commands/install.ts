import type { CommandSpec } from "./types.js";

/** Owner: cli+binary team (wiring, launchd timer); the host part is HostAdapter.install (adapters team). */
export const command: CommandSpec = {
  name: "install",
  summary: "Install the plugin for a host (claude-code | codex) and the auto-resume timer",
};
