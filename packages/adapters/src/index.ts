/** @vtc/adapters: host adapters implementing HostAdapter from @vtc/shared (AD-1, AD-6). */
import type { HostAdapter, HostCapabilities, HostId } from "@vtc/shared";
import { claudeCodeCapabilities, createClaudeCodeAdapter } from "./claude-code/index.js";
import { codexCapabilities, createCodexAdapter } from "./codex/index.js";

export {
  claudeCodeCapabilities,
  claudeSubagentName,
  createClaudeCodeAdapter,
  STATUSLINE_TEE,
  statuslineIngestFromClaude,
  statuslineTeeCommand,
  type ClaudeCodeAdapterOptions,
} from "./claude-code/index.js";
export {
  codexCapabilities,
  codexUsageFromRateLimits,
  createCodexAdapter,
  type CodexAdapterOptions,
} from "./codex/index.js";
export type { ProcessExit, SpawnedProcess, Spawner, SpawnOptions } from "./common/process.js";

export const HOST_CAPABILITIES: Readonly<Record<HostId, HostCapabilities>> = {
  "claude-code": claudeCodeCapabilities,
  codex: codexCapabilities,
};

/**
 * What the cli may pass when it constructs an adapter. Models are not here: the engine resolves
 * every model id (`SpawnRoleRequest.model`, AD-6 rule 2), the Codex tier map included.
 */
export interface AdapterFactoryOptions {
  /** The running vtc version (reported to host servers the adapter talks to). */
  readonly vtcVersion?: string;
  /**
   * This host's compiled plugin on disk (the cli's extracted `plugin:<host>`). Claude Code loads
   * it into headless runs with `--plugin-dir`, isolated from the user's own settings.
   */
  readonly pluginDir?: string;
}

/**
 * The adapter registry: the only way the cli constructs a `HostAdapter` (AD-6). A host appears
 * here once its adapter implements `sandboxProfile`, `headlessCommand` and `install`
 * (sub-project 3), and registering it is what makes `adapters.test.ts` run the AD-9 safety
 * contract for that host: an adapter cannot be wired without passing it. Constructing an adapter
 * starts nothing; child processes start on first use and stop on `dispose()`.
 */
export const ADAPTER_FACTORIES: Readonly<
  Partial<Record<HostId, (options?: AdapterFactoryOptions) => HostAdapter>>
> = {
  "claude-code": (options = {}) =>
    createClaudeCodeAdapter(
      options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir },
    ),
  codex: (options = {}) =>
    createCodexAdapter(
      options.vtcVersion === undefined ? {} : { clientVersion: options.vtcVersion },
    ),
};
