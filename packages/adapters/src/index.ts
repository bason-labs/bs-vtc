/** @vtc/adapters: host adapters implementing HostAdapter from @vtc/shared (AD-1, AD-6). */
import type { HostCapabilities, HostId } from "@vtc/shared";
import { claudeCodeCapabilities } from "./claude-code/index.js";
import { codexCapabilities } from "./codex/index.js";

export { claudeCodeCapabilities, statuslineIngestFromClaude } from "./claude-code/index.js";
export { codexCapabilities } from "./codex/index.js";

export const HOST_CAPABILITIES: Readonly<Record<HostId, HostCapabilities>> = {
  "claude-code": claudeCodeCapabilities,
  codex: codexCapabilities,
};
