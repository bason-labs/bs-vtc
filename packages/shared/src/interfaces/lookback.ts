/**
 * Replay arm plugins (spine §5 reading 201, D-cg). New in contracts 5.0.0.
 *
 * On a host whose headless run loads the compiled agent (Claude Code, `HEADLESS_LOADS_AGENT`), a
 * Lookback replay arm runs its own temporary plugin: a full copy of the compiled `vtc` plugin in
 * which only the agent's editable section differs. The roles-compiler team implements
 * {@link ArmPluginCompiler} in `@vtc/compiler`; the cli binds it to the shipped plugin and injects it
 * (`EngineDeps.armPlugins`); the engine passes the result as `SpawnRoleRequest.pluginDir`, and the
 * adapter proves which copy loaded (`HeadlessRun.pluginLoad`).
 */
import type { HostId, Sha256Hex } from "../primitives.js";

export interface ArmPluginRequest {
  readonly host: HostId;
  /** `agentNameFor(role, mode)`, without the host namespace. */
  readonly agent: string;
  /** The arm's editable section (`a`/`aa`: the baseline's, `b`: the candidate's). */
  readonly editable: string;
  /**
   * Absolute, empty output directory under the engine's private area
   * (`<vtcHome>/guard/lookback/arms/<trial>/<arm>/`). It must stay unchanged until the run exits:
   * the host loads it in place.
   */
  readonly outDir: string;
}

export interface ArmPlugin {
  /** `outDir`, now holding the plugin (manifest name `vtc`, so `--agent vtc:<agent>` resolves). */
  readonly dir: string;
  /** `arm-<first 12 hex of the directory's content hash>`, the manifest version. */
  readonly version: string;
  /** `effectivePromptSha(locked, editable)` of the agent in this copy. */
  readonly promptSha256: Sha256Hex;
}

export interface ArmPluginCompiler {
  /** Writes the arm plugin; every path stays inside `outDir`, with no symlink. */
  compileArm(request: ArmPluginRequest): Promise<ArmPlugin>;
}

/**
 * The adapter's proof of which plugin copy a run loaded (`HeadlessRun.pluginLoad`). `loaded: false`
 * (for instance a managed-settings lock kept the installed plugin) makes the trial `gate_infra`,
 * never a verdict, and records `automation.skipped` with reason `plugin_locked`.
 */
export type PluginLoadProof =
  | { readonly loaded: true; readonly dir: string }
  | { readonly loaded: false; readonly reason: string };
