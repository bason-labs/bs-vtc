/**
 * Dispatch policy (§4.2 step 2, §6.9, §12.4, §12.5; spine AD-4 rule 4 and AD-17). Pure: decides
 * how a role run happens from the project's dispatch mode and what the host can do. The engine
 * never starts a headless run unless this returns `headless`.
 */
import type { SessionSandboxState } from "../engine-instance.js";
import type { HostCapabilities } from "../interfaces/host-adapter.js";
import type { HostId } from "../primitives.js";
import type { DispatchMode } from "../project-config.js";
import type { ToolProfile } from "../role-contract.js";

/** Why the engine wants a role run. */
export type DispatchPurpose = "role" | "auto_resume" | "cross_family_review";

/**
 * - `subagent`: a `spawn_role` action the Lead performs;
 * - `headless`: the engine launches it through `HostAdapter.spawnRole` (headless dispatch);
 * - `lead_redispatch`: plugin-only auto-resume. The step stays `interrupted`, `next` returns
 *   `wait` until the reset, then a `spawn_role` that resumes the same session;
 * - `unavailable`: cannot run in this mode (cross-family review in plugin-only mode, or a host
 *   with neither subagents nor allowed headless runs). The engine skips or parks it.
 */
export type DispatchPlan = "subagent" | "headless" | "lead_redispatch" | "unavailable";

export const planDispatch = (
  purpose: DispatchPurpose,
  mode: DispatchMode,
  capabilities: Pick<HostCapabilities, "subagents" | "headless">,
): DispatchPlan => {
  const headless = mode === "headless_allowed" && capabilities.headless;
  switch (purpose) {
    case "role":
      if (capabilities.subagents) return "subagent";
      return headless ? "headless" : "unavailable";
    case "auto_resume":
      return headless ? "headless" : "lead_redispatch";
    case "cross_family_review":
      return headless ? "headless" : "unavailable";
  }
};

/**
 * The text a task parks with (reason `blocked`, an escalation the human answers to retry) when
 * the engine refuses an in-session dispatch because the Lead session's sandbox is not on (D-an,
 * spine §5 reading 71).
 */
export const SESSION_SANDBOX_OFF_REASON =
  "the Lead session's OS sandbox is not on, so a role with a shell cannot run in it: run `vtc install --host claude-code` in this repo (it shows and writes the sandbox settings to .claude/settings.local.json), restart the Claude Code session, then answer this escalation to retry";

/**
 * Platforms where Codex's network-off sandbox (`read-only`, or `workspace-write` with
 * `network_access = false`) is shown to block a `connect()` to a Unix socket as well as TCP
 * (macOS seatbelt, codex-cli 0.162.1, checked 2026-10-14; see the adapters' Codex profile). Only
 * there can a Codex role, which can read the VTC install token (Codex sandboxes allow reads
 * everywhere), be kept from presenting it to the engine's socket as a cli hello (D-an).
 */
export const CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS: readonly string[] = ["darwin"];

/**
 * The text a task parks with (reason `blocked`) when the engine refuses an in-session Codex
 * dispatch on a platform outside {@link CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS} (spine §5 reading
 * 79): the headless Codex profile's fail-closed rule, applied to subagents.
 */
export const CODEX_IN_SESSION_REFUSED_REASON =
  "a Codex role can read the VTC install token, and on this platform Codex's sandbox is not shown to keep it from connecting to the engine's socket, so Codex roles do not run here: set hosts.dispatch for this role's family to claude-code in .vtc/project.yaml (or run the Lead in Claude Code), commit it, then answer this escalation to retry";

/**
 * Pure (D-an, spine §5 readings 71 and 79): why a `subagent` dispatch may not go ahead, or `null`
 * when it may.
 * - Claude Code: a code-running role (`code_sandboxed`, it has a shell) needs the Lead session to
 *   report its sandbox `on` (`EngineSocketHello.session_sandbox`; absent = `unknown`); roles
 *   without a shell are confined by their agent's tool and path rules.
 * - Codex: every role has a shell and can read the token, so every profile needs a `platform` in
 *   {@link CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS} (the compiled agent pins the network off,
 *   `codexAgentNetworkOff`); absent platform refuses.
 */
export const inSessionDispatchRefusal = (
  host: HostId,
  profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
  platform: string | undefined,
): string | null => {
  if (host === "codex")
    return platform !== undefined && CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS.includes(platform)
      ? null
      : CODEX_IN_SESSION_REFUSED_REASON;
  return profile === "code_sandboxed" && sessionSandbox !== "on"
    ? SESSION_SANDBOX_OFF_REASON
    : null;
};

/** Pure: whether {@link inSessionDispatchRefusal} lets the dispatch go ahead. */
export const inSessionDispatchAllowed = (
  host: HostId,
  profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
  platform: string | undefined,
): boolean => inSessionDispatchRefusal(host, profile, sessionSandbox, platform) === null;
