/**
 * @vtc/compiler: neutral role, skill and plugin sources → the Claude Code and Codex plugins
 * (§4.1, §4.4, §12; spine AD-9, AD-14, AD-16). Depends on @vtc/shared only (AD-1).
 */
export * from "./types.js";
export * from "./checks.js";
export * from "./role-source.js";
export * from "./frontmatter.js";
export * from "./toml.js";
export * from "./hosts.js";
export * from "./instructions.js";
// `routingStartTier` stays internal: the start-tier rule is engine core's (`core/routing.ts`),
// and this copy only renders the Planner's table until a shared `startTierFor` exists.
export {
  renderHighRiskTags,
  renderRoutingTable,
  TIER_HINT_REASON_DIRECTION,
  tierHintReasons,
} from "./routing.js";
export * from "./advisors.js";
export * from "./compile.js";
export * from "./io.js";
export * from "./hooks.js";
export * from "./prompt-parts.js";
export * from "./role-skills.js";
export * from "./codex-plugin.js";
export * from "./templates.js";
export * from "./arm-plugin.js";
export * from "./scaffold.js";
