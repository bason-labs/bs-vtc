/**
 * Codex sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure.
 * Reviewers run in the `read-only` sandbox; write-scoped roles and engineers in `workspace-write`
 * (writes limited to the worktree, never any network). Codex has no per-path write-deny, so the engine's write-scope check is the only path enforcement
 * (§12.1). Every sandbox key a profile relies on is set explicitly on the command line, so the
 * user's `config.toml` cannot widen it (network access, extra writable roots). Nothing here ever
 * names a full-access sandbox or a bypass.
 *
 * The install phase's registry network (§7.2) is refused: Codex can only open the whole network,
 * and Codex sandboxes allow reads everywhere, so a role could read the VTC install token and the
 * host credentials and use the token against the engine's localhost API. The engine runs the
 * install phase on a host that scopes the network (Claude Code) until it has a mitigation that
 * makes the install token useless to role processes.
 *
 * Known gaps, recorded for the engine:
 * - Codex sandboxes allow reads everywhere, so a role process can read the VTC install token and
 *   the host credential files; there is no per-path read deny to set. With the network always
 *   off the process cannot send them anywhere, but it can copy them into its output or worktree.
 * - `codex exec` has no agent flag: a headless run gets no compiled role instructions
 *   (`developer_instructions` of `.codex/agents/vtc-*.toml`), so the role rests on the prompt
 *   (the task pack). Engine-launched Codex runs (cross-family review, auto-resume) must carry the
 *   role's instructions in the prompt until the spike settles how to load them.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  HostCommand,
  SandboxProfile,
  SandboxProfileRequest,
  SessionRef,
  SpawnRoleRequest,
} from "@vtc/shared";

export const CODEX_BINARY = "codex";
export const HOST = "codex";

type CodexSandboxMode = "read-only" | "workspace-write";

export const codexSandboxProfile = (request: SandboxProfileRequest): SandboxProfile => {
  const mode: CodexSandboxMode =
    request.tools.profile === "read_only" ? "read-only" : "workspace-write";
  if (mode === "workspace-write" && request.network === "registries") {
    throw new Error(
      "refusing the registries network on Codex: it cannot limit the network to package registries (§7.2), and an open network lets a role use the readable VTC install token against the engine; run the install phase on Claude Code",
    );
  }
  return {
    host: HOST,
    enforced: {
      readOnly: mode === "read-only",
      perPathWriteDeny: false,
      network: true,
    },
    settings: {
      sandbox_mode: mode,
      ...(mode === "workspace-write"
        ? { sandbox_workspace_write: { network_access: false, writable_roots: [] } }
        : {}),
    },
    // config overrides, not `--sandbox`: `codex exec resume` takes only `--config` (0.162.1)
    cliArgs: [
      "--config",
      `sandbox_mode="${mode}"`,
      ...(mode === "workspace-write"
        ? [
            "--config",
            "sandbox_workspace_write.network_access=false",
            "--config",
            "sandbox_workspace_write.writable_roots=[]",
          ]
        : []),
    ],
  };
};

/**
 * Where `--output-schema` reads the schema from: a file named by the schema's hash under the
 * adapter's private scratch directory (`spawnRole` writes it before the run starts).
 */
export const codexSchemaFile = (scratchDir: string, schema: Readonly<Record<string, unknown>>) =>
  join(
    scratchDir,
    `role-result-${createHash("sha256").update(JSON.stringify(schema)).digest("hex").slice(0, 16)}.json`,
  );

export interface CodexCommandOptions {
  readonly scratchDir: string;
}

/**
 * `codex exec --json` for a role, or `codex exec resume --json … <thread_id>` (spike 1 and the
 * 4h resume check). The model is the engine's (`request.model.model`, AD-6 rule 2). The prompt
 * is read from stdin (`-`): the launcher writes it and closes stdin, so it never sits in argv.
 * The thread id follows `--`, so it is never read as an option.
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
  return {
    command: CODEX_BINARY,
    args: [
      "exec",
      ...(session === undefined ? [] : ["resume"]),
      "--json",
      ...request.sandbox.cliArgs,
      "--output-schema",
      codexSchemaFile(options.scratchDir, request.outputSchema),
      // no resolved id (D-ae): the session's default model runs, only the effort is set
      ...(request.model.model === undefined ? [] : ["--model", request.model.model]),
      "--config",
      `model_reasoning_effort="${request.model.effort}"`,
      "--",
      ...(session === undefined ? [] : [session.id]),
      "-",
    ],
    env: {},
  };
};
