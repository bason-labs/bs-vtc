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
 * the engine refuses an in-session dispatch because the Lead session's sandbox settings are not
 * on (D-an, spine §5 readings 71 and 81).
 */
export const SESSION_SANDBOX_OFF_REASON =
  "the Lead session's sandbox and file-tool deny rules are not on, so no role can run in it: run `vtc install --host claude-code` in this repo (it shows and writes the settings to .claude/settings.local.json), restart the Claude Code session, then answer this escalation to retry";

/**
 * Platforms where Codex's network-off sandbox (`read-only`, or `workspace-write` with
 * `network_access = false`) is shown to block a `connect()` to a Unix socket as well as TCP
 * (macOS seatbelt, codex-cli 0.162.1, checked 2026-10-14; see the adapters' Codex profile). Only
 * there can a headless Codex role, which can read the VTC install token (Codex sandboxes allow
 * reads everywhere), be kept from presenting it to the engine's socket as a cli hello (D-an).
 */
export const CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS: readonly string[] = ["darwin"];

/**
 * The text a task parks with (reason `blocked`) when the engine refuses an in-session Codex
 * dispatch (spine §5 reading 82). A Codex custom agent inherits the parent session's sandbox,
 * approvals and MCP servers ("a custom agent file can't override those settings",
 * developers.openai.com/codex/subagents), so the compiled agent cannot pin the network off, and
 * nothing VTC can read shows that the Lead's own Codex session has it off (`--sandbox`,
 * `--yolo` and `/permissions` change it at runtime). A Codex role can read the install token, so
 * with the network on it could reach the engine's socket as a cli (a human channel).
 *
 * A step dispatches on the Lead session's own host (`dispatchNow`) and the engine launches no
 * headless runs (reading 93), so a Codex Lead can run no roles at all in v1: the one remedy is a
 * Claude Code Lead. There is no per-family host setting in `.vtc/project.yaml` (F7).
 */
export const CODEX_IN_SESSION_REFUSED_REASON =
  "a Codex role runs with the Lead session's own Codex sandbox and network (a Codex agent file cannot narrow them), VTC cannot confirm that sandbox keeps the network off, and a Codex role can read the VTC install token, so Codex roles do not run in-session; roles run on the Lead's own host, so a Codex Lead can run no roles in v1: close this Codex session, run the Lead in Claude Code (vtc install --host claude-code in this repo, then open it in Claude Code with the vtc plugin and continue the run), then answer this escalation from that session to retry";

/**
 * Pure (D-an, spine §5 readings 71, 79, 81 and 82): why a `subagent` dispatch may not go ahead,
 * or `null` when it may.
 * - Claude Code: every role needs the Lead session to report its settings `on`
 *   (`EngineSocketHello.session_sandbox`; absent = `unknown`). The sandbox confines a role's
 *   shell, and the same settings' `permissions.deny` rules are what keep a role's Read, Edit and
 *   Write tools off the install token, the credential stores and the hidden-test checkouts: a
 *   compiled agent can carry no path rule (a specifier in its `disallowedTools` removes the whole
 *   tool), so no profile is safe without them.
 * - Codex: always refused in-session ({@link CODEX_IN_SESSION_REFUSED_REASON}); `platform` and
 *   the session report do not change that until a spine §7 spike shows a way to confirm the
 *   Codex Lead session's sandbox.
 */
export const inSessionDispatchRefusal = (
  host: HostId,
  _profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
  _platform: string | undefined,
): string | null => {
  if (host === "codex") return CODEX_IN_SESSION_REFUSED_REASON;
  return sessionSandbox === "on" ? null : SESSION_SANDBOX_OFF_REASON;
};

/** Pure: whether {@link inSessionDispatchRefusal} lets the dispatch go ahead. */
export const inSessionDispatchAllowed = (
  host: HostId,
  profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
  platform: string | undefined,
): boolean => inSessionDispatchRefusal(host, profile, sessionSandbox, platform) === null;
