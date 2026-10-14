/**
 * Which dispatches can take a pinned editable section (AD-21 rules 2 and 6; spine §5 readings 117,
 * 145 and 176): shared by the dispatcher (pins and canaries) and RETRO's replays. And which
 * targets a replay can grade at all (reading 180), shared by RETRO and `vtc lookback approve`.
 */
import { resolveRoleMode, type HostId, type RoleContract } from "@vtc/shared";
import type { PromptParts } from "./plugins.js";

/**
 * Whether a host's headless run loads the compiled plugin agent itself (`claude -p --agent`,
 * spine §7 "Claude headless plugin agent"). `codex exec` has no agent flag (spine §7 "Codex
 * headless role identity"): the engine carries the role's locked core in the prompt and its
 * editable section in the pack.
 */
export const HEADLESS_LOADS_AGENT: Readonly<Record<HostId, boolean>> = {
  "claude-code": true,
  codex: false,
};

/**
 * Why a dispatch's agent cannot take a pinned editable section, or `null` when it can (AD-21
 * rule 6, reading 176): an `editable_in_pack` agent on either host, or any agent in a headless run
 * on a host whose runs do not load the compiled agent ({@link HEADLESS_LOADS_AGENT}); either way
 * its manifest names the locked core's SHA.
 */
export const pinBlocker = (
  parts: PromptParts | undefined,
  host: HostId,
  dispatch: "subagent" | "headless",
): string | null => {
  if (parts === undefined) return "the plugin has no manifest entry for it";
  if (parts.lockedSha256 === undefined) return "its manifest names no locked_sha256";
  if (parts.editableInPack || (dispatch === "headless" && !HEADLESS_LOADS_AGENT[host])) return null;
  return `it carries its own editable section (not editable_in_pack) and this ${dispatch === "headless" ? `${host} headless run loads the compiled agent` : "run is a subagent of the Lead"}, so a pinned section cannot reach it until its role is switched`;
};

/**
 * Whether a role's trial can leave work in its checkout for the gates to grade (reading 180): it
 * may write files (in its effective mode) and its contract names an artifact. A verdict role's
 * trial leaves its head at the base, so the Gate Runner would grade the same commit for every arm.
 */
export const roleChangesFiles = (contract: RoleContract, mode?: string): boolean => {
  const effective = resolveRoleMode(contract, mode);
  const role = effective.ok ? effective.contract : contract;
  return role.tools.profile !== "read_only" && role.output.artifacts.length > 0;
};

/**
 * Why no replay of a target can run in v1, or `null` (AD-21 rule 6; spine §5 readings 176 and
 * 180). A target's replay runs on a run its host leads, so: a role that changes no file is never
 * replayed (reading 180: both arms would leave the same base for the gates; a verdict grader would
 * reopen it), and on a host whose runs load the compiled agent ({@link HEADLESS_LOADS_AGENT}) a
 * role that is not `editable_in_pack` cannot run a candidate. Since a canary starts only from a
 * replay result that says improve, `null` is also the condition for `vtc lookback approve` to be
 * able to start one (reading 182(8)).
 */
export const replayReach = (
  target: { readonly agent: string; readonly host: HostId },
  parts: { readonly editableInPack: boolean; readonly changesFiles: boolean },
): string | null => {
  if (!parts.changesFiles)
    return `${target.agent} changes no file, so the gates would grade the same base for both arms; a verdict role takes pins but is not replayed in v1 until a grader scores its verdicts against the recorded outcome (spine §5 reading 180)`;
  if (HEADLESS_LOADS_AGENT[target.host] && !parts.editableInPack)
    return `${target.agent} replays only on a run led from ${target.host}, where every dispatch loads its compiled agent, and it is not editable_in_pack, so a trial cannot run the candidate (spine §5 readings 176 and 180)`;
  return null;
};
