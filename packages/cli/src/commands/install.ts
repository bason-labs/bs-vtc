import { pendingCommand } from "./types.js";

/** Owner: cli+binary team (wiring, launchd timer); the host part is HostAdapter.install (adapters team), which places the compiled plugin (AD-16). */
export const command = pendingCommand(
  "install",
  "Install the plugin for a host (claude-code | codex) and the auto-resume timer",
);
