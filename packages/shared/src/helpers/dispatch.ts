/**
 * Dispatch policy (§4.2 step 2, §6.9, §12.4, §12.5; spine AD-4 rule 4 and AD-17). Pure: decides
 * how a role run happens from the project's dispatch mode and what the host can do. The engine
 * never starts a headless run unless this returns `headless`.
 */
import type { HostCapabilities } from "../interfaces/host-adapter.js";
import type { DispatchMode } from "../project-config.js";

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
