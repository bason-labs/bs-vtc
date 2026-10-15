/** @vtc/adapters: host adapters implementing HostAdapter from @vtc/shared (AD-1, AD-6). */
import type { HostAdapter, HostCapabilities, HostId } from "@vtc/shared";
import { claudeCodeCapabilities, createClaudeCodeAdapter } from "./claude-code/index.js";
import { codexCapabilities, createCodexAdapter } from "./codex/index.js";
import type { Spawner } from "./common/process.js";

export {
  claudeCodeCapabilities,
  claudeSubagentName,
  createClaudeCodeAdapter,
  statuslineIngestFromClaude,
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
 * What the cli passes when it constructs an adapter: `{ pluginDir, vtcHome, vtcVersion }`.
 * Models are not here: the engine resolves every model id (`SpawnRoleRequest.model`, AD-6
 * rule 2), and with none resolved the host session's default model runs (D-ae).
 */
export interface AdapterFactoryOptions {
  /** The running vtc version (reported to host servers the adapter talks to). */
  readonly vtcVersion?: string;
  /**
   * This host's compiled plugin on disk (the cli's extracted `plugin:<host>`). Claude Code loads
   * it into headless runs with `--plugin-dir`, isolated from the user's own settings, and refuses
   * a headless run without it.
   */
  readonly pluginDir?: string;
  /**
   * The absolute VTC home the cli resolved (`$VTC_HOME` or `~/.vtc`): no role reads anything in
   * `ROLE_DENIED_VTC.homeReadDeny` or writes anything in `homeWriteDeny` (D-w, D-ap, D-an), and
   * the Claude install writes the session sandbox for it.
   */
  readonly vtcHome?: string;
  /**
   * The user's `~/.vtc/config.yaml` `env_passthrough` names (D-ak, spine §5 reading 57): they
   * reach headless host children besides the fixed allowlist; host credential variables never
   * do. Default: none.
   */
  readonly envPassthrough?: readonly string[];
  /**
   * Tests only: starts host processes instead of the real spawner, so a test that runs the
   * factory-built adapter (the safety contract, `install`) never starts a real host binary. The
   * cli never passes it.
   */
  readonly spawner?: Spawner;
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
    createClaudeCodeAdapter({
      ...(options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir }),
      ...(options.vtcHome === undefined ? {} : { vtcHome: options.vtcHome }),
      ...(options.envPassthrough === undefined ? {} : { envPassthrough: options.envPassthrough }),
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
    }),
  codex: (options = {}) =>
    createCodexAdapter({
      ...(options.vtcVersion === undefined ? {} : { clientVersion: options.vtcVersion }),
      ...(options.vtcHome === undefined ? {} : { vtcHome: options.vtcHome }),
      ...(options.envPassthrough === undefined ? {} : { envPassthrough: options.envPassthrough }),
      ...(options.spawner === undefined ? {} : { spawner: options.spawner }),
    }),
};
