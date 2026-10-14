/**
 * Which dispatches can take a pinned editable section (AD-21 rules 2 and 6; spine §5 readings 117,
 * 145 and 176): shared by the dispatcher (pins and canaries) and RETRO's replays.
 */
import type { HostId } from "@vtc/shared";
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
