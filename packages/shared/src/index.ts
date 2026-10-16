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
export * from "./upstream.js";
export * from "./tier-routing.js";
export * from "./signals.js";
export * from "./interfaces/host-adapter.js";
export type * from "./interfaces/storage.js";
export type * from "./interfaces/gate-runner.js";
export type * from "./interfaces/assets.js";
export type * from "./interfaces/auto-resume.js";
export type * from "./interfaces/engine.js";
export type * from "./interfaces/git.js";
export type * from "./interfaces/automation.js";
export type * from "./interfaces/lookback.js";
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
 *
 * 4.12.0 (MINOR): the closing-round fix round (spine §5 reading 182). `ROLE_DENIED_VTC
 * .homeWriteDeny` adds `guard/**`, the engine's private directory, so every role profile and the
 * Lead session deny writes there; `EDITABLE_IN_PACK_ROLES` moves here from `@vtc/compiler`, the
 * one list the compiler switches and the engine's tests build from; the core event
 * `lookback.unattributed` counts the failures the attribution tree leaves inconclusive while no
 * AI tiebreak runs (spec §13); `CLAUDE_LEAD_REPLAYABLE_ROLES` names the roles a Claude-led run can
 * replay (none in v1, readings 180 and 182(8)), for the dashboard's Lookback view. All additive:
 * new constants, a new event type and one more deny glob (a deny list only narrows what a role
 * may do).
 *
 * 5.0.0 (MAJOR): round 4, automatic issues and PRs (spine AD-27, §5 readings 184–209; H-4..H-8,
 * D-bu..D-cl). MAJOR because hidden acceptance tests move to a run-keyed layout,
 * `~/.vtc/hidden/<repo-key>/<run>/<task>/` (`hiddenTestsDir`, D-ck): a persisted layout, written
 * by engine core and read by the Gate Runner, which switch to it together at the round's merge.
 * `GateRunRequest.hidden_tasks` entries may name another run's task (`<run>:T-n`,
 * `hiddenTestsRef`). Also: `HostBilling` `provider` and `PROVIDER_BILLING_NOTICE` (D-ci); the
 * automation contracts in `upstream.ts` (kinds, targets, the identity marker, labels, branch names
 * and `autoPushRefAllowed`, `AUTOMATION_LIMITS`, the `UpstreamReport` privacy allowlist,
 * `EvidenceHosting` / `EvidenceManifest` / `EVIDENCE_LIMITS`, templates and their slots,
 * `ROLES_CHANGELOG`, the `upstream.*` and `automation.skipped` events, `AutomationReport` on
 * `GET /api/automation`, `run.started.automation`); the seams `IssueService`,
 * `AutoPullRequestService`, `GitPlumbing`, `EvidenceRecorder`, `AutomationDeps`
 * (`EngineDeps.automation`) and `ArmPluginCompiler` (`EngineDeps.armPlugins`,
 * `SpawnRoleRequest.pluginDir`, `HeadlessRun.pluginLoad`, D-cg); config `project.yaml`
 * `upstream` / `automation`, `~/.vtc/config.yaml` `upstream` / `automation` and `automationFor`;
 * `gates.yml` `visual.redact_selectors`; `effectiveMergeLevel`'s `automatic` cap
 * (`AUTOMATIC_RUN_MAX_MERGE_LEVEL`, D-bw); `NextResult.notices` (the daily summary, D-ca); D-cf's
 * `CODEX_HOST_WEB_SEARCH`, `HostCapabilities.safeHostWeb` and `hostWebRoute`; `planDispatch`
 * sends every `lookback_replay` trial headless (D-cg); `LOOKBACK_LIMITS.maxTrialsPerRetro`,
 * `ReplayGrader`, `ReplayResult.grader`, `VERDICT_GRADED_ROLES` and `replayGraderFor` (D-ch),
 * which supersede `CLAUDE_LEAD_REPLAYABLE_ROLES` (removed at the round-4 merge, reading 209(2)).
 *
 * 5.1.0 (MINOR): the round-4 merge (spine §5 readings 210–214). `LOOKBACK_HOME.replayTrialsFile`
 * with `ReplayTrialRow` / `ReplayInfraRow` (`ReplayInfraOutcomeSchema`), the replay trial ledger
 * the lookback module kept locally (D-cg); a verdict replay's task key is
 * `<run>:<subject>:<verdict>:<task>` (doc only). `TaskPack.design_exit` and the Dispatch lines
 * `design direction: <id>` / `design exit: category_standard` (reading 179 as amended);
 * `PACK_INPUT_TYPES.automationIssue` (reading 198). `QUIET_CLOSE_MARKER`, `ROLES_CHANGELOG_ANCHOR`,
 * `EVIDENCE_MODE_PARAM` / `EVIDENCE_MODE_VALUES`, and what the `note` and `provenance` template
 * slots hold. `AutoIssueRef.createdAt` / `closedQuietByVtc` (optional). `REPO_ROLE_DENIED
 * .writeDeny` adds `.vtc/evidence/auto/**`. Doc: `AutomationDeps.upstream` is read live,
 * `AutomationDeps.hosting` is probed when the daemon starts, and `headlessCommand` reflects what
 * the adapter last read from the host. All additive: new constants, optional fields, new
 * schemas, and one more deny glob. `CLAUDE_LEAD_REPLAYABLE_ROLES` is gone, as 5.0.0 planned
 * (reading 209(2)).
 *
 * 5.2.0 (MINOR): the round-4 fix round (spine §5 reading 215). `AutomationSkipReason`
 * `stale_baseline` (a Lookback PR whose replay measured another prompt than the upstream default
 * branch's); `UpstreamReport.model` refuses an ARN and a 12-digit run (an account id): the
 * engine is its only producer and never persists it, and it now sends a non-public model id as
 * `custom`; `AutomationDeps.ghLogin` (optional), the gh-login probe readings 211 and 214 deferred.
 *
 * 5.3.0 (MINOR): the round-4 closing fixes (spine §5 reading 216). `incident.recorded.stack`
 * (optional): a crash keeps the VTC frames of its stack, root-relative, so a VTC defect can be
 * located and fixed by an automatic run; `AUTO_LABELS.fixable` (`vtc:fixable`), the label of an
 * automatic issue VTC works on itself; `AutoIssueRef.title` / `body` (optional), so the bs-vtc
 * checkout's engine can start a run from an issue another project's daemon opened;
 * `AutomationDeps.vtcAdvisories` (optional), the daily offline scan of VTC's own dependencies.
 * All additive.
 *
 * 5.4.0 (MINOR): round 5, difficulty-based model routing and the improvement signals (spine §5
 * readings 217–227; H-9, D-cm..D-ct). `tier-routing.ts`: `TaskDraft.tier_hint` / `Task.tier_hint`
 * (`TierHint`, reason-coded), `RoutingTable` and `DEFAULT_ROUTING_TABLE`, `taskRiskClass`,
 * `clampTier`, `QA_AUTHOR_MIN_TIER`, `project.yaml` `routing` (`start`, `min_tier`, `max_tier`;
 * `routingFor`), `TIER_EFFORT_WITHOUT_MODEL` (D-co's interim), `routingConfigSubject`;
 * `role.dispatched.tier` / `tier_reason` / `tier_clamped` and the same on `RoleRunSummary`
 * (`TierReason`). `signals.ts` (D-cs): `CommandShape` and `commandShapes`,
 * `role.submitted.command_shapes`, `ParsedStream.commandShapes`, the hook's spool
 * (`COMMAND_SHAPE_SPOOL_FILE`, `CommandShapeSpoolRow`), `MissingCapability` on `Question`,
 * `Escalation` and `EscalationAnswer`, `TOOL_SIGNAL_MIN_TASKS` and `CAPABILITY_SIGNAL_MIN`.
 * Lookback (D-cn, D-cq, D-cr): `RoutingScorecard` (`LOOKBACK_REPO.routingScorecard`), the pace
 * and drift limits in `LOOKBACK_LIMITS`, `~/.vtc/config.yaml` `lookback` and `lookbackPaceFor`.
 * Evidence (D-ct, D-cc): `EvidenceRecorder.captureBeforeAfter` (optional), `EvidencePartialReason`
 * on `EvidenceManifest` and `upstream.pr_opened`, `touchesUi` / `UI_FILE_EXTENSIONS`,
 * `EVIDENCE_HOSTING_PREFERRED`. Followups of readings 211 and 212: `GitPlumbing.fetch` /
 * `message` (optional), `AutomationSkipReason` `error` (the dashboard's exhaustive map updated in
 * the same change), `ControlResult` for `pause` / `resume` (a `NoRunControlResult` where 5.3.0
 * answered `no_run`, so an older reader sees a refused call either way) and
 * `RunControlResult.automation_paused`, `branch.pushed` / `push_failed` `remote_ref`. `ModelTier`
 * and `Effort` move to `primitives.ts` (re-exported from `role-contract.ts`; same schemas).
 *
 * 5.5.0 (MINOR): the round-5 merge (spine §5 readings 228–231). `routedStartTier`, the one pure
 * copy of the routing table's start-tier rule (engine core, Lookback, the compiler and the cli
 * call it); `ROUTING_FACT_METRICS`, the metric names of a routing `config` fact;
 * `COMMAND_SHAPE_SUBCOMMAND_PROGRAMS`: `commandShapes` records a subcommand only after a program
 * that has subcommands, so no argument value survives as one (amends reading 221(1));
 * `HEADLESS_ROLE_ENV` and hook contract rule 7 (the headless role run marker);
 * `AutomationItem.pr.partial_reason` (optional); `GitPlumbing.changedPaths` / `mergeBase`
 * (optional). Doc only: a Planner hint on a high-risk task is raised to `high_floor`
 * (`TierHint`, reading 228), `AUTO_TEMPLATE_SLOTS`' `diff` is the CHANGELOG entry's, the
 * `RoutingScorecard` cost cell's `n` counts priced tasks, `AutomationReport.evidence_hosting` is
 * the resolved hosting, and the daemon reads the user's `lookback` config itself. All additive.
 *
 * 5.6.0 (MINOR): the round-5 fix round (spine §5 reading 232). `commandShapes` keeps no argument
 * value in any form: a here-document's body (`<<WORD`, `<<-WORD`) is data, never a command, and a
 * flag word reaches the flag hash by its name only (a single-dash word by its first letter, a long
 * flag by its name, a numeric flag as `-#`), so `-pS3cret` and `-pOther` hash alike; the shared
 * heredoc rule is exported (`heredocAt`, `skipHeredocBodies`, `Heredoc`) for the adapters' shell
 * wrapper reader. A shape key recorded before 5.6.0 may differ from the same command's key now
 * (its flag hash). `AutomationSkipReason` `out_of_scope`: an automatic PR that changes files its
 * kind may not (a routing-table PR, reading 228(6)) is refused before it opens (the dashboard's
 * exhaustive map updated in the same change). All additive.
 *
 * 5.7.0 (MINOR): round 6 (spine §5 readings 234–248). Routing (D-cu, D-cv): `routedByDifficulty`
 * (the table starts the producers only), `reviewerStartTier` (a reviewer on its own tier, Security
 * verify and the cross-family reviewer one tier up on a high-risk task), `TIER_ESCALATION` and
 * `escalationSteps` (a Low start escalates every failed round). Prices (H-12): `PriceTable`,
 * `HostAdapter.defaultPrices`, `effectivePrices`, `priceCeiling`, `priceRun`,
 * `role.submitted.budget_usd`; `UserConfig.prices` becomes an optional override (doc). The G2
 * coverage loop (H-13): `DESIGN_COVERAGE_LOOP`, `designCoverageComplete`,
 * `designCoverageRedispatch`, `DesignCoverageGaps` on `TaskPack.coverage_gaps` (Dispatch lines),
 * the `design.coverage_checked` event (`DesignCoverageChecked`),
 * `DESIGN_COVERAGE_ESCALATION_OPTIONS`; a REQ an AD names counts as covered (doc). Check tools
 * (H-14): `GateSchema.tool` (`CheckTool`), `GateResult.tool` (`ToolIntegrity`),
 * `TOOL_TAMPER_RULE_ID`. Codex model fallback (D-cx): `HostErrorCause` `model_refused` (the
 * dashboard's exhaustive map updated in the same change), `role.dispatched.model_fallback`
 * (`ModelFallback`), `MODEL_REFUSALS_FILE` and `ModelRefusalRow`. The round-5 carryover: the tier
 * arm of a replay (`ReplayTrialRef.tier`, the ledger rows' `tier`, `RoutingReplayResult`,
 * `routingReplayId` / `routingReplayPath`, `routingReplayBacks`,
 * `LOOKBACK_REPO.routingReplaysDir`, `ROUTING_FACT_METRICS.replayVerdict` / `replayTrials`,
 * `ROUTING_REPLAY_VERDICT_CODES`); scripted flows (`DESIGN_FLOWS_PATH`, `DesignFlowsFile`,
 * `FlowStep`, `FLOW_LIMITS`, `selectDesignFlow`, `BeforeAfterRequest.flow`,
 * `BeforeAfterResult.flow`); a typed `UpstreamReport.subject` (`UpstreamSubject`,
 * `UPSTREAM_CONFIG_KEYS`, `upstreamSubjectKey`); `command_shapes` on `role.failed` and
 * `role.rejected`; `CommandShapeSpoolRow.action`. All additive.
 *
 * 5.8.0 (MINOR): the round-6 integration fixes (spine §5 reading 249). `budget_usd` on
 * `role.rejected`, `role.failed` and `limit.hit`, as on `role.submitted` (H-12): what a run with no
 * known price counts toward the budgets, on its own closing event, so a run with no task (an
 * advisor, the front half) is never counted at $0. `ToolIntegrity.baseline` (H-14):
 * `after_scripts` marks a project tool hashed only after an install's scripts ran, which its
 * `sha256` cannot vouch for. `ReplayTrialRef.grader_bundle_sha`: the scope a tier replay trial's
 * dispatch belongs to, so Lookback judges a tier replay on its own scope's dispatches only. All
 * additive.
 *
 * 5.9.0 (MINOR): the round-6 review fixes (spine §5 reading 250). `UserConfig.gates
 * .allow_tools_hashed_after_scripts` (`gatesAllowToolsHashedAfterScripts`) and
 * `GateRunnerDeps.allowToolsHashedAfterScripts` (H-14): a verify gate whose `project` tool was
 * hashed only after an install's scripts ran no longer runs unless the user opts in here. All
 * additive.
 *
 * 5.10.0 (MINOR): H-14 independent of command parsing (spine §5 reading 251).
 * `ToolIntegrity.workspace_sha256`: the hash of every tool the workspace can run, taken before the
 * install phase's scripts, which every `project` gate is checked against whatever its command;
 * `UserConfig.gates.allow_tools_hashed_after_scripts` has no effect any more (a gate hashed after
 * an install's scripts runs, marked `after_scripts` with a warning). All additive.
 */
export const CONTRACTS_VERSION = "5.10.0";
