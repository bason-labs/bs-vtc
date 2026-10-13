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
 * Pure (D-an): whether a `subagent` dispatch may go ahead given what the Lead session reported
 * about its sandbox (`EngineSocketHello.session_sandbox`; absent = `unknown`). Only a
 * code-running role (`code_sandboxed`, it has a shell) in a Claude Code Lead session needs the
 * session sandbox `on`; Codex subagents carry their own per-agent `sandbox_mode`, and roles
 * without a shell are confined by their agent's tool and path rules.
 */
export const inSessionDispatchAllowed = (
  host: HostId,
  profile: ToolProfile,
  sessionSandbox: SessionSandboxState | undefined,
): boolean => !(host === "claude-code" && profile === "code_sandboxed") || sessionSandbox === "on";
