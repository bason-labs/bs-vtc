/**
 * What the engine asks of a host sandbox for a role run (D-ac, spine §5 reading 49; §7.2 two-phase
 * sandbox; AD-5). A dependency install is the Gate Runner's engine-run install phase, never a role
 * action, so every role run is requested with no network: a role can then never reach the
 * engine's localhost API, whatever it can read. Where the host cannot hide the install token and
 * the host credential files from the role (`enforced.secretsUnreadable` false, Codex), the "no
 * network" must be enforced by the host itself, or the run does not start.
 *
 * Why not an engine-side check of the caller's process tree (the adapters team's other option):
 * the HTTP API (AD-5) authenticates a bearer token and binds 127.0.0.1; a localhost peer's process
 * tree is not portably observable (no peer credentials on a TCP socket, and Bun and Node expose
 * none), and in plugin-only mode a role subagent runs inside the Lead's own host process, so a
 * process-tree rule could not tell a role from the Lead. Denying the role every network route
 * is the barrier that fits AD-5.
 *
 * Plugin-only mode (AD-17) launches no headless run, so no engine code asks an adapter for a
 * sandbox: a role subagent there runs under the compiled role profile its plugin agent carries
 * (the roles compiler and the adapters own that). These two helpers guard the engine-launched
 * headless path and are mandatory for it: any engine or cli source that calls an adapter's
 * `sandboxProfile`, `spawnRole` or `headlessCommand` must build its request with
 * {@link roleSandboxRequest} and refuse an unsafe profile with {@link roleSandboxProblem}
 * (`test/core/sandbox-wiring.test.ts` fails otherwise).
 */
import type { RoleContract, SandboxProfile, SandboxProfileRequest } from "@vtc/shared";

/** A role run's sandbox request: always `network: "none"` (reading 49). */
export const roleSandboxRequest = (
  contract: Pick<RoleContract, "tools">,
  where: Pick<SandboxProfileRequest, "cwd" | "writablePaths" | "protectedPaths">,
): SandboxProfileRequest => ({
  tools: contract.tools,
  cwd: where.cwd,
  writablePaths: where.writablePaths,
  protectedPaths: where.protectedPaths,
  network: "none",
});

/**
 * Why a host's sandbox profile is unsafe for a role run, or `null` when it is safe: a host that
 * cannot keep the token and the host credential files unreadable (`secretsUnreadable` not true)
 * must itself enforce "no network", or the role could carry the token to the engine's API.
 */
export const roleSandboxProblem = (profile: SandboxProfile): string | null => {
  if (profile.enforced.secretsUnreadable === true) return null;
  if (profile.enforced.network) return null;
  return `${profile.host} cannot keep the VTC install token unreadable and does not enforce the role's no-network sandbox; refusing to start the role run (D-ac)`;
};
