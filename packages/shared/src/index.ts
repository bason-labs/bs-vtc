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
export * from "./headless.js";
export * from "./auto-merge.js";
export * from "./research.js";
export * from "./lookback.js";
export * from "./visual.js";
export * from "./architecture-checks.js";
export * from "./spend.js";
export * from "./interfaces/host-adapter.js";
export type * from "./interfaces/storage.js";
export type * from "./interfaces/gate-runner.js";
export type * from "./interfaces/assets.js";
export type * from "./interfaces/auto-resume.js";
export type * from "./interfaces/engine.js";
export type * from "./interfaces/git.js";
export * from "./interfaces/research.js";
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
 * 4.4.0 (MINOR): Final Review fix round (spine §5 readings 81–90, Lead decisions D-av..D-ax).
 * `GatesConfig.sandbox.verify_loopback` and `GateSandboxSpec.loopback` (D-av); the run's
 * `run.started.origin`, `ResumeInput.adopt` and incident kind `run_adopted` (reading 88);
 * `InstallRequest.vtcHome` (reading 83); the Lead session settings' `permissions.deny`
 * (`claudeSessionPermissionDeny`, `VTC_HOME_SHELL_SPELLINGS`, reading 81); every Claude role
 * needing the session settings and no in-session Codex role (`inSessionDispatchRefusal`,
 * readings 81 and 82). All additive: optional fields, an enum value, new helpers.
 * 4.5.0 (MINOR): wave 3, v1 completion (spine AD-21..AD-26, §5 readings 96–110, Lead decisions
 * D-ay..D-bb, human decisions H-1 and H-2). Headless runs: `ROLE_DISPATCH_BY_LEAD_HOST` and an
 * optional `leadHost` of `planDispatch` (a Codex Lead's roles run headless), purpose
 * `lookback_replay`, `HeadlessPolicy` and `hosts.headless`, `HostOutcome` `error.cause`,
 * `HostAuthStatus` and `HostAdapter.authStatus?`, `SpawnRoleRequest.idleTimeoutMs`,
 * `HOST_DISALLOWED_ARGS`, `headlessIsolationGaps`, the AD-9 marker
 * `dangerously-bypass-hook-trust`, `StatusResult.headless_runs`. Level 3: `RemoteMergeService`
 * (optional `EngineDeps.remoteMerge`), `RemoteMergePolicy`, `level3Preflight`,
 * `autoMergeChecklist`, the merge-level ledger and `effectiveMergeLevel`, `GH_FORBIDDEN_ARGS`,
 * `PullRequestRef.number` / `auto_merge` / `required_checks` / `merge_state_status`. G2 and Final
 * Review: `approve_gate.directions` / `facts`, `ApproveInput.fact_waivers`, `G2Direction`,
 * `DesignCoverageReport`, `FinalReviewStepResult`,
 * `ReleaseReadiness`, `SCOPE_CREEP_RULE_ID`. Lookback: prompt versions, pins, attribution,
 * scorecards, proposals, replays, canaries and their pure statistics. Research: fetch requests
 * and results, the cache, facts and locators, the network guard, `ROLE_MCP_TOOLS`, optional
 * `EngineDeps.http`. Visual: `VisualReport` / `VisualSummary` (`GateReport.visual`),
 * `GateRunRequest.visual`, `GatesConfig.visual`, `BrowserPin`, the novelty check and design
 * library. New core events for each, and `role.dispatched.editable_sha256` / `canary_arm`.
 * `WAVE3_HOME_WRITE_DENY` (folded into `ROLE_DENIED_VTC.homeWriteDeny` at the wave-3 merge). All
 * additive: optional fields, new contracts, new
 * constants and helpers; no existing enum gained a value a consumer maps exhaustively.
 *
 * 4.6.0 (MINOR): the wave-3 merge (spine §5 readings 111–134). `IncidentKind` `auth` and
 * `MergePreflightFailure` `no_merge_service` (new values in enums the engine, cli and dashboard
 * map exhaustively: every consumer is updated in the same change, and nothing released reads
 * 4.5.0 logs, reading 134). The Designer's direction draft, direction and novelty paths and the
 * component spec (`G2DirectionDraft`, `ComponentSpec`); the AD Check block format
 * (`AdCheckSpec`); `GatesConfig.visual.app` (`VisualApp`) and the browser store layout;
 * `TaskPack.role_heuristics`, `TASK_PACK_HEURISTICS_SECTION` and the free-text heading escape
 * (`escapePackText`); `ROLE_PROMPTS_ASSET_DIR` / `rolePromptAssetPath` and
 * `PluginManifestAgent.editable_in_pack`; `LOOKBACK_HOME.pinsLock` / `aaNoiseFile`,
 * `lookbackTraceRef` and the run-qualified `splitForTrace` input,
 * `lookback.replay_finished.sha256`; `UserConfig.research.api_keys` and
 * `EngineDeps.researchApiKey`; `HttpGuardError` and the cross-origin redirect header rule;
 * optional `GateRunner.checkNovelty` / `recordDesignChoice`; informational findings
 * (`sarif_level: none`) no longer count against `new_violations`; `datamarkFetchedText` caps its
 * whole output. `ROLE_DENIED_VTC` folds in `WAVE3_HOME_WRITE_DENY` and denies the `lookback` and
 * `merge-level` gestures; `REPO_ROLE_DENIED.writeDeny` adds the engine's git-tracked records.
 *
 * 4.7.0 (MINOR): the wave-3 integration round (spine §5 readings 135–143). `IncidentKind`
 * `prompt_selection` (the dashboard's exhaustive map updated in the same change);
 * `VisualSummary.toolchain` / `VisualReport.toolchain` (`VisualToolchain`) and the visual report
 * path; `LOOKBACK_HOME.tiebreaksFile` and `LookbackTiebreakRecord`; `AaNoiseRow` and the exported
 * `RepoKeySchema`; `RESEARCH_CACHE.requestsFile` and `ResearchCacheRequestRow`; the design
 * library layout (doc only). A GitHub `FetchRequest.repo` may no longer start a name with a dot,
 * and `REPO_ROLE_DENIED.writeDeny` adds `.vtc/runs/**` (reading 143 says why both ship as MINOR).
 *
 * 4.8.0 (MINOR): the wave-3 fix round (spine §5 reading 146). `DesignCoverageReport` adds
 * `reqs_without_component` (the REQ → component check of §6.1 DESIGN) and `screens_problem` (a UI
 * run's missing or invalid `screens.yaml`), both counted in `ok`; `approve_gate` carries the
 * report as `design_coverage`, since an approval is refused while it fails.
 *
 * 4.9.0 (MINOR): the wave-3 Final Review fix round (spine §5 readings 149–155). G2's design exits
 * (`DesignExitSchema`: `approve_gate.design_exits` / `gate.requested.design_exits`,
 * `ApproveInput.design_exit`, `gate.approved.design_exit` and `gate.rejected.design_exit`); the
 * user's price table (`UserConfig.prices`, `ModelPriceSchema`, `priceTokens`, `EngineDeps.prices`);
 * cost per client (`ClientSpendRow` under `CLIENT_SPEND_DIR`, `ClientSpendReport`,
 * `clientSpendReport`, the `clientSpend` route `GET /api/spend`).
 *
 * 4.10.0 (MINOR): the wave-3 closing round (spine §5 readings 156–176). H-3 host web search:
 * `RoleTools.host_web`, `FactReportedSource` (`FactRow.reported_source`,
 * `FactProposeInput.reported_source`), `SearchProvider` and `UserConfig.research.search_provider`
 * (no default), `EngineDeps.researchSearchProvider`. D-bq: `HostBilling` (`HostAuthStatus.billing`, `UsageSnapshot.billing`) and
 * `API_KEY_BILLING_WARNING`. D-bd: `EscalationEffect` `finish_level_2`. D-bt:
 * `DesignCoverageReport.directions_problem` (counted in `ok`) and `G2_DIRECTIONS`. D-br:
 * `engineerProfileLockedSection`. Moved here: `editableSectionErrors` and
 * `RESERVED_EDITABLE_HEADINGS` (from `@vtc/compiler`) and `lookbackTiebreakKey` (the lookback
 * module's `tiebreakKey`), with the tiebreak store's writer rules on `LOOKBACK_HOME.tiebreaksFile`.
 *
 * 4.11.0 (MINOR): the closing-round integration (spine §5 readings 177–181). Replay trials in the
 * log: `role.dispatched.purpose` (`RoleDispatchPurpose`) and `role.dispatched.replay`
 * (`ReplayTrialRef`). Replay isolation: `SandboxProfileRequest.readDeny`,
 * `SandboxProfile.enforced.readDeny` and `ReplayResult.isolation` (`ReplayIsolation`). The chosen
 * G2 direction in post-G2 packs: `TaskPack.design_direction`; the key-screen design contracts'
 * path (`DESIGN_CONTRACTS_DIR`, `designContractPath`).
 */
export const CONTRACTS_VERSION = "4.11.0";
