/**
 * @vtc/shared: the frozen contracts every other package builds against.
 * Runtime-agnostic (Node, Bun, browser): no Node or Bun built-ins or globals (AD-2).
 * Owned by the integrator (AD-15): teams propose changes, the integrator merges them.
 */
export * from "./primitives.js";
export * from "./run.js";
export * from "./task.js";
export * from "./feature.js";
export * from "./finding.js";
export * from "./question.js";
export * from "./escalation.js";
export * from "./event-payloads.js";
export * from "./event.js";
export * from "./role-result.js";
export * from "./role-contract.js";
export * from "./project-config.js";
export * from "./gates-config.js";
export * from "./gate-result.js";
export * from "./usage.js";
export * from "./workflow.js";
export * from "./traceability.js";
export * from "./engine-instance.js";
export * from "./engine-api.js";
export * from "./interfaces/host-adapter.js";
export type * from "./interfaces/storage.js";
export type * from "./interfaces/gate-runner.js";
export type * from "./interfaces/assets.js";
export type * from "./interfaces/auto-resume.js";
export * from "./helpers/fingerprint.js";
export * from "./helpers/severity.js";
export * from "./helpers/tokens.js";
export * from "./helpers/agent-name.js";
export * from "./helpers/role-prompt.js";
export * from "./helpers/compliance.js";
export * from "./json-schema.js";

/**
 * Contract version. MAJOR bumps when a frozen contract changes incompatibly (AD-3 rule 4).
 * 2.0.0: fix round 1 of the phase-1 review (typed event payloads, gate runner, HTTP/MCP outputs,
 * engine instance, run/phase, questions, modes, structured output). Nothing consumed 1.x yet.
 */
export const CONTRACTS_VERSION = "2.0.0";
