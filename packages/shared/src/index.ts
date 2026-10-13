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
export * from "./artifact-types.js";
export * from "./design.js";
export * from "./plugin-manifest.js";
export * from "./hook.js";
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
export * from "./helpers/final-review.js";
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
 * 4.1.0 (MINOR): wave-1 proposals. The `consult` tool for advisors, the resolved `model` on
 * `spawn_role`, `session_ref` on a submitted result, typed `branch.push_failed` and
 * `feature.pr_failed`, incident kinds `config_changed` and `checkout_write`, merge-level reason
 * `no_remote`, `final_review.steps_run`, project.yaml `git.sign_commits` and
 * `budgets.advisor_usd`, task-pack depths and design constraints, `PluginManifest`,
 * `DesignScreensFile`, the role-contracts asset path, the `vtc hook` command contract, known
 * artifact types, the `PullRequestService` seam, and a host-neutral structured-output form.
 * 4.2.0 (MINOR): wave-2 proposals (spine §5 readings 40–68). `GateRunRequest.hidden_tasks` and
 * `gates_config_hash`; `UserConfig` (`~/.vtc/config.yaml` `env_passthrough`); the tool-severity
 * cap outside the security class (`ToolSeverityInput.category`); `finalReviewStepsCovered`;
 * `STATUSLINE_TEE` / `statuslineTeeCommand`; `HOST_CREDENTIAL_DENY_READ` and its deny-list
 * exemption in `findForbiddenHostArgs`; `ROLE_DENIED_VTC`; `SandboxProfile.enforced
 * .secretsUnreadable`; `DEFAULT_INSTALL_SCOPE`; an optional `ResolvedModel.model`; and
 * `WriteScopeGlobSchema` for `files_scope` and `write_paths`. Two of these narrow or widen an
 * existing shape, which AD-3 rule 4 would call MAJOR; they ship as MINOR because nothing has
 * persisted or consumed the affected values yet (reading 51 and 63 say why).
 * 4.3.0 (MINOR): hardening round (spine §5 readings 69–78, Lead decisions D-al..D-au). The gate
 * sandbox (`GateSandbox` / `GateSandboxSpec` on optional `GateRunnerDeps.sandbox` and
 * `allowUnsandboxed`, `GateSandboxKindSchema`, `GATE_SANDBOX`, `GateReport.sandbox`, the
 * user-level optional `gates.allow_unsandboxed` and `gatesAllowUnsandboxed`); the human channel
 * (`HUMAN_ONLY_TOOLS`, `humanChannelRequired`, `EngineSocketHello.install_token`); the session
 * sandbox signal (`SessionSandboxStateSchema`, `EngineSocketHello.session_sandbox`,
 * `claudeSessionSandboxSettings` / `claudeSessionSandboxState`, `inSessionDispatchAllowed`,
 * `SESSION_SANDBOX_OFF_REASON`); `ROLE_DENIED_VTC.homeWriteDeny` widened and `homeReadDeny`
 * added; incident kinds `host_config_restored` and `unsandboxed_gate`;
 * `ScannerPin.binary_sha256`; `STATUSLINE_TEE.usageExit` / `misconfiguredLine`;
 * `GATES_CONFIG_FILE` / `gatesConfigNotCommitted`; budget semantics for a host-reported cost
 * (doc only). All additive: optional fields, enum values, new constants and helpers. Widening a
 * deny list narrows what roles may do, not what a contract accepts (spine §5 reading 73).
 * The integration of that round (spine §5 reading 79) added helpers and constants only, with no
 * schema change, before anything outside the integration branch consumed 4.3.0:
 * `SessionSandboxScope` as a parameter of `claudeSessionSandboxSettings` / `State`,
 * `hostConfigDirsOf`, `HOME_CREDENTIAL_LOCATIONS`, `REPO_ROLE_DENIED`, `inSessionDispatchRefusal`
 * and a `platform` parameter of `inSessionDispatchAllowed`, `CODEX_UNIX_CONNECT_BLOCKED_PLATFORMS`,
 * `CODEX_IN_SESSION_REFUSED_REASON`, `PROJECT_CONFIG_FILE` / `projectConfigNotCommitted`.
 */
export const CONTRACTS_VERSION = "4.3.0";
