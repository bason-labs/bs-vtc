/**
 * Codex sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure.
 * Reviewers run in the `read-only` sandbox; write-scoped roles and engineers in `workspace-write`
 * (writes limited to the worktree, no network unless the install phase needs registries). Codex has no per-path write-deny, so the engine's write-scope check is
 * the only path enforcement (§12.1). Nothing here ever names a full-access sandbox or a bypass.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  HostCommand,
  ModelTier,
  SandboxProfile,
  SandboxProfileRequest,
  SessionRef,
  SpawnRoleRequest,
} from "@vtc/shared";

export const CODEX_BINARY = "codex";
export const HOST = "codex";

/**
 * The built-in Codex top/mid/low → model map (spine §5 reading 26). Empty until the spike names
 * Codex model ids (spine §7): meanwhile a run sets only the reasoning effort and uses the
 * session's model. `project.yaml` `hosts.models.codex` overrides it per tier.
 */
export const CODEX_DEFAULT_TIER_MODELS: Readonly<Partial<Record<ModelTier, string>>> = {};

export type CodexTierModels = Readonly<Partial<Record<ModelTier, string>>>;

/** The model id for a tier: the project's override, else the built-in map, else none. */
export const codexModelFor = (tier: ModelTier, overrides: CodexTierModels = {}): string | null =>
  overrides[tier] ?? CODEX_DEFAULT_TIER_MODELS[tier] ?? null;

type CodexSandboxMode = "read-only" | "workspace-write";

export const codexSandboxProfile = (request: SandboxProfileRequest): SandboxProfile => {
  const mode: CodexSandboxMode =
    request.tools.profile === "read_only" ? "read-only" : "workspace-write";
  // workspace-write has no network by default; registries need it opened (not per domain)
  const network = mode === "workspace-write" && request.network === "registries";
  return {
    host: HOST,
    enforced: {
      readOnly: mode === "read-only",
      perPathWriteDeny: false,
      network: !network,
    },
    settings: {
      sandbox_mode: mode,
      ...(mode === "workspace-write"
        ? { sandbox_workspace_write: { network_access: network } }
        : {}),
    },
    // a config override, not `--sandbox`: `codex exec resume` takes only `--config` (0.162.1)
    cliArgs: [
      "--config",
      `sandbox_mode="${mode}"`,
      ...(network ? ["--config", "sandbox_workspace_write.network_access=true"] : []),
    ],
  };
};

/**
 * Where `--output-schema` reads the schema from: a file named by the schema's hash under the
 * adapter's scratch directory (`spawnRole` writes it before the run starts).
 */
export const codexSchemaFile = (scratchDir: string, schema: Readonly<Record<string, unknown>>) =>
  join(
    scratchDir,
    `role-result-${createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16)}.json`,
  );

export interface CodexCommandOptions {
  readonly scratchDir: string;
  readonly models?: CodexTierModels;
}

/**
 * `codex exec --json` for a role, or `codex exec resume --json … <thread_id>` (spike 1 and the
 * 4h resume check). stdin is closed by the launcher (`codex exec` waits on an open stdin). The
 * prompt and thread id follow `--`, so no prompt text is read as an option.
 */
export const codexHeadlessCommand = (
  request: SpawnRoleRequest,
  options: CodexCommandOptions,
  session?: SessionRef,
): HostCommand => {
  if (request.sandbox.host !== HOST) {
    throw new Error(`a ${request.sandbox.host} sandbox profile cannot run on ${HOST}`);
  }
  if (session !== undefined && session.host !== HOST) {
    throw new Error(`cannot resume a ${session.host} session on ${HOST}`);
  }
  const model = codexModelFor(request.model.tier, options.models);
  return {
    command: CODEX_BINARY,
    args: [
      "exec",
      ...(session === undefined ? [] : ["resume"]),
      "--json",
      ...request.sandbox.cliArgs,
      "--output-schema",
      codexSchemaFile(options.scratchDir, request.outputSchema),
      ...(model === null ? [] : ["--model", model]),
      "--config",
      `model_reasoning_effort="${request.model.effort}"`,
      "--",
      ...(session === undefined ? [] : [session.id]),
      request.prompt,
    ],
    env: {},
  };
};
