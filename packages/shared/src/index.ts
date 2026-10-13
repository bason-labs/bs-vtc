/**
 * @vtc/shared: the frozen contracts every other package builds against.
 * Runtime-agnostic (Node, Bun, browser): no Node or Bun built-ins (AD-2).
 */
export * from "./primitives.js";
export * from "./task.js";
export * from "./feature.js";
export * from "./finding.js";
export * from "./escalation.js";
export * from "./event.js";
export * from "./role-result.js";
export * from "./role-contract.js";
export * from "./project-config.js";
export * from "./gates-config.js";
export * from "./usage.js";
export * from "./workflow.js";
export * from "./engine-api.js";
export * from "./interfaces/host-adapter.js";
export type * from "./interfaces/storage.js";
export * from "./helpers/fingerprint.js";
export * from "./helpers/severity.js";
export * from "./helpers/tokens.js";
export * from "./json-schema.js";

/** Contract version. MAJOR bumps when a frozen contract changes incompatibly. */
export const CONTRACTS_VERSION = "1.0.0";
