/** @vtc/adapters: host adapters implementing HostAdapter from @vtc/shared (AD-1, AD-6). */
import type { HostAdapter, HostCapabilities, HostId } from "@vtc/shared";
import { claudeCodeCapabilities } from "./claude-code/index.js";
import { codexCapabilities } from "./codex/index.js";

export { claudeCodeCapabilities, statuslineIngestFromClaude } from "./claude-code/index.js";
export { codexCapabilities } from "./codex/index.js";

export const HOST_CAPABILITIES: Readonly<Record<HostId, HostCapabilities>> = {
  "claude-code": claudeCodeCapabilities,
  codex: codexCapabilities,
};

/**
 * The adapter registry: the only way the cli constructs a `HostAdapter` (AD-6). A host appears
 * here once its adapter implements `sandboxProfile`, `headlessCommand` and `install`
 * (sub-project 3), and registering it is what makes `adapters.test.ts` run the AD-9 safety
 * contract for that host: an adapter cannot be wired without passing it.
 */
export const ADAPTER_FACTORIES: Readonly<Partial<Record<HostId, () => HostAdapter>>> = {};
