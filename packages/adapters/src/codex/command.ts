/**
 * Codex sandbox profiles and headless commands (§12.1, AD-6, AD-9). Pure, except that the
 * VTC-home overlap check resolves symlinks in the paths it compares (no file is read).
 * Reviewers run in the `read-only` sandbox; write-scoped roles and engineers in `workspace-write`
 * (writes limited to the worktree, never any network). Codex has no per-path write-deny, so the
 * engine's write-scope check is the only path enforcement (§12.1). Every sandbox key a profile
 * relies on is set explicitly on the command line, so the user's `config.toml` cannot widen it
 * (network access, extra writable roots). Nothing here ever names a full-access sandbox or a
 * bypass.
 *
 * The registry network (§7.2) is refused for every role (D-ac, spine §5 reading 49): Codex can
 * only open the whole network, and Codex sandboxes allow reads everywhere, so a role could read
 * the VTC install token and the host credentials and use the token against the engine's
 * localhost API. Dependency installs are an engine-run step, never a role action.
 *
 * Known gaps, recorded for the engine (and in the tests):
 * - Codex sandboxes allow reads everywhere, so a role process can read the VTC install token and
 *   the host credential files; there is no per-path read deny to set (D-ad), so
 *   `enforced.secretsUnreadable` is false. With the network always off the process cannot send
 *   them anywhere, but it can copy them into its output or worktree.
 * - The role deny list (D-w): Codex has no per-command deny for a headless run, so `vtc
 *   calibrate` cannot be denied here (it confirms only in an interactive terminal, which a role
 *   run never has). Writes to the VTC home's allowlists, scanner database and hidden tests are
 *   blocked because `workspace-write` writes only the worktree and the OS temp roots (`$TMPDIR`,
 *   `/tmp`; D-ag lets roles write there). So a profile whose worktree overlaps one of those
 *   directories is refused, and when one lies under a temp root (a VTC home in the temp
 *   directory, as in test setups) the profile takes both temp roots out of the writable set
 *   (`exclude_tmpdir_env_var`, `exclude_slash_tmp`). Paths compare by real location, so a
 *   symlinked worktree or VTC home cannot hide an overlap.
 * - `codex exec` has no agent flag: a headless run gets no compiled role instructions
 *   (`developer_instructions` of `.codex/agents/vtc-*.toml`), so the role rests on the prompt
 *   (the task pack). Engine-launched Codex runs (cross-family review, auto-resume) must carry the
 *   role's instructions in the prompt until the spike settles how to load them.
 */
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type {
  HostCommand,
  SandboxProfile,
  SandboxProfileRequest,
  SessionRef,
  SpawnRoleRequest,
} from "@vtc/shared";
import { canonicalPath, vtcHomeWriteDeniedDirs } from "../common/homes.js";

export const CODEX_BINARY = "codex";
export const HOST = "codex";

type CodexSandboxMode = "read-only" | "workspace-write";

export interface CodexProfileOptions {
  /** The absolute VTC home (`~/.vtc`, or `$VTC_HOME`), which no role may write (D-w). */
  readonly vtcHome: string;
  /**
   * The OS temp roots a `workspace-write` sandbox can write besides the worktree. Default:
   * `$TMPDIR`, `os.tmpdir()` and `/tmp`; tests pass their own.
   */
  readonly tempRoots?: readonly string[];
}

const defaultTempRoots = (): string[] =>
  [process.env.TMPDIR, tmpdir(), "/tmp"].filter(
    (root): root is string => root !== undefined && root !== "",
  );

/** True when `inner` is `outer` or below it (both already canonical). */
const within = (outer: string, inner: string): boolean => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
};

export const codexSandboxProfile = (
  request: SandboxProfileRequest,
  options: CodexProfileOptions,
): SandboxProfile => {
  const mode: CodexSandboxMode =
    request.tools.profile === "read_only" ? "read-only" : "workspace-write";
  if (request.network === "registries") {
    throw new Error(
      "refusing the registries network on Codex: it cannot limit the network to package registries (§7.2), and an open network lets a role use the readable VTC install token against the engine; dependency installs are an engine-run step (D-ac)",
    );
  }
  // compared by real location, each path resolved once
  const denied =
    mode === "workspace-write" ? vtcHomeWriteDeniedDirs(options.vtcHome).map(canonicalPath) : [];
  const cwd = denied.length === 0 ? request.cwd : canonicalPath(request.cwd);
  const exposed = denied.find((dir) => within(cwd, dir) || within(dir, cwd));
  if (exposed !== undefined) {
    throw new Error(
      `refusing a workspace-write Codex role in ${request.cwd}: ${exposed} in the VTC home would be writable, and Codex cannot deny writes there (D-w)`,
    );
  }
  // the temp roots are writable too (D-ag); a denied directory under one takes them out
  const tempRoots =
    denied.length === 0 ? [] : (options.tempRoots ?? defaultTempRoots()).map(canonicalPath);
  const noTemp = denied.some((dir) => tempRoots.some((root) => within(root, dir)));
  return {
    host: HOST,
    enforced: {
      readOnly: mode === "read-only",
      perPathWriteDeny: false,
      network: true,
      // no per-path read deny on Codex: the token and host credentials stay readable (D-ad)
      secretsUnreadable: false,
    },
    settings: {
      sandbox_mode: mode,
      ...(mode === "workspace-write"
        ? {
            sandbox_workspace_write: {
              network_access: false,
              writable_roots: [],
              ...(noTemp ? { exclude_tmpdir_env_var: true, exclude_slash_tmp: true } : {}),
            },
          }
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
      ...(noTemp
        ? [
            "--config",
            "sandbox_workspace_write.exclude_tmpdir_env_var=true",
            "--config",
            "sandbox_workspace_write.exclude_slash_tmp=true",
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
