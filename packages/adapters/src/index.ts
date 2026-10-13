/** @vtc/adapters: host adapters implementing HostAdapter from @vtc/shared (AD-1, AD-6). */
import type { HostAdapter, HostCapabilities, HostId, ModelTier } from "@vtc/shared";
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
  CODEX_DEFAULT_TIER_MODELS,
  codexCapabilities,
  codexModelFor,
  codexUsageFromRateLimits,
  createCodexAdapter,
  type CodexAdapterOptions,
} from "./codex/index.js";
export type { ProcessExit, SpawnedProcess, Spawner, SpawnOptions } from "./common/process.js";

export const HOST_CAPABILITIES: Readonly<Record<HostId, HostCapabilities>> = {
  "claude-code": claudeCodeCapabilities,
  codex: codexCapabilities,
};

/** What the cli passes when it constructs an adapter. */
export interface AdapterFactoryOptions {
  /** `project.yaml` `hosts.models.<host>`: the project's tier → model overrides for this host. */
  readonly models?: Readonly<Partial<Record<ModelTier, string>>>;
  /** The running vtc version (reported to host servers the adapter talks to). */
  readonly vtcVersion?: string;
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
  // Claude model ids come resolved from the engine (aliases), so it needs no tier map
  "claude-code": () => createClaudeCodeAdapter(),
  codex: (options = {}) =>
    createCodexAdapter({
      ...(options.models === undefined ? {} : { models: options.models }),
      ...(options.vtcVersion === undefined ? {} : { clientVersion: options.vtcVersion }),
    }),
};
