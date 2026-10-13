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
export * from "./task-pack.js";
export * from "./engine-instance.js";
export * from "./engine-api.js";
export * from "./asset-paths.js";
export * from "./persisted.js";
export * from "./interfaces/host-adapter.js";
export type * from "./interfaces/storage.js";
export type * from "./interfaces/gate-runner.js";
export type * from "./interfaces/assets.js";
export type * from "./interfaces/auto-resume.js";
export type * from "./interfaces/engine.js";
export type * from "./interfaces/git.js";
export * from "./helpers/fingerprint.js";
export * from "./helpers/severity.js";
export * from "./helpers/tokens.js";
export * from "./helpers/agent-name.js";
export * from "./helpers/role-prompt.js";
export * from "./helpers/compliance.js";
export * from "./helpers/redaction.js";
export * from "./helpers/routing.js";
export * from "./helpers/dispatch.js";
export * from "./helpers/conformance.js";
export * from "./json-schema.js";

/**
 * Contract version. MAJOR bumps when a frozen contract changes incompatibly (AD-3 rule 4).
 * Every version's schema hash is recorded in `schemas/contracts-ledger.json`; a schema change
 * without a new version entry fails `json-schema.test.ts`.
 * 2.0.0: fix round 1 of the phase-1 review (typed event payloads, gate runner, HTTP/MCP outputs,
 * engine instance, run/phase, questions, modes, structured output). Nothing consumed 1.x yet.
 * 3.0.0: fix round 2 (verdicts with evidence and one evidence vocabulary, replay-complete core
 * events, required trace fields, single risk-rule encoding, finding kinds, task packs,
 * traceability and evidence bundles, gate guards and hidden tests, cookie-free sessions,
 * artifacts/diff/features routes, prototype origin, plugin-only dispatch). Nothing consumed 2.x.
 * 4.0.0: closing round of the phase-1 review (tool findings, test metrics and traceability in gate
 * reports; replayable request and intent; one feature per run, engine-created tasks and
 * dependency rules; submit snapshot commits; push, PR state and CI; park risk rules; the test
 * layout, gate allowlist and socket protocol; tolerant readers of persisted data). Nothing
 * consumed 3.x.
 */
export const CONTRACTS_VERSION = "4.0.0";
