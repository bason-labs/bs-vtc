/**
 * Engine core (AD-13; owner: engine-core team, sub-project 1): state, events, scheduler, loops,
 * budgets, triage, escalation, merge queue, tracing. Reaches the Gate Runner only through the
 * `GateRunner` interface and git only through `../git/index.ts`.
 */
export {
  acquireEngineLock,
  EngineLockedError,
  LOCK_PROBE_DELAYS_MS,
  LOCK_STARTUP_GRACE_MS,
  readLockHolder,
  takeEngineLock,
  type AcquireLockOptions,
  type EngineLock,
  type LockHolder,
  type StaleLockReason,
  type TakeLockOptions,
} from "./lock.js";
export {
  openEventLog,
  type EventDraft,
  type EventLogWriter,
  type OpenEventLogOptions,
} from "./event-log.js";
export {
  engineDiscoveryPath,
  readEngineDiscovery,
  removeEngineDiscovery,
  writeEngineDiscovery,
} from "./discovery.js";
export {
  applyEvent,
  findingKey,
  projectRun,
  type FindingRecord,
  type GateReportRecord,
  type LimitRecord,
  type RoleRunRecord,
  type RunState,
} from "./state.js";
export { loadRuns, type LoadedRun } from "./run-store.js";
export {
  activeRun,
  createReadModel,
  diffLineCounts,
  readArtifact,
  taskAcceptanceCriteria,
  type ReadModel,
  type ReadModelDeps,
  type ReadResult,
} from "./read-model.js";
export {
  escalationListView,
  eventPageView,
  featureListView,
  openEscalations,
  planFilePath,
  runListView,
  statusView,
  taskDetailView,
  taskListView,
  usageReportView,
} from "./views.js";
export { projectGraph, taskDagGraph, taskNodeState, taskPipelineGraph } from "./graph.js";
export { Engine, type EventListener } from "./engine.js";
export {
  EngineError,
  type CallContext,
  type EngineCoreDeps,
  type FactRefresher,
  type LookbackRetro,
  type LookbackReplay,
  type LookbackReplayTrial,
  type LookbackRetroTarget,
  type ReplayTrialOutcome,
  type LookbackTargetRef,
  type PinnedPrompt,
  type PromptPins,
  type PromptTarget,
  type RoleToolHandler,
  type RunHandle,
} from "./kernel.js";
export {
  compiledRoleContracts,
  createRoleRegistry,
  DEFAULT_TIER_MODELS,
  REQUIRED_ROLES,
  resolveModel,
  RoleContractsError,
  writePathsOf,
  type RoleRegistry,
} from "./roles.js";
export {
  createPluginCatalog,
  pluginCatalogFrom,
  pluginManifest,
  PluginManifestError,
  type PluginCatalog,
  type PromptParts,
} from "./plugins.js";
export {
  appendPrivateFile,
  ensurePrivateDir,
  guardDirFor,
  GUARD_DIR,
  readPrivateFile,
  writePrivateFile,
} from "./guard.js";
export { EngineWrites, type WriteCheck } from "./engine-writes.js";
export { ENGINE_FILE_DIRS, FORENSICS_DIR, type DispatchRecord } from "./dispatch-guard.js";
export { roleWorktreeId, ROLE_INPUT_DIRS } from "./role-worktree.js";
export { globMatch, globToRegExp, matchesAny } from "./globs.js";
export {
  dispatchWorktree,
  dispatchWriteScope,
  isCheckoutScopeEntry,
  readDispatchPack,
  splitWriteScope,
  taskPackJsonPath,
  type DispatchWriteScope,
  type ScopeOwner,
} from "./dispatch-scope.js";
export { roleSandboxProblem, roleSandboxRequest } from "./sandbox.js";
export { finalReviewScopeNote, finalReviewStepsRun } from "./projections.js";
export { architectDepth, dealDesignConstraints, LOTTERY_POOLS, researchDepth } from "./lottery.js";
export {
  committedGatesConfig,
  parseProjectConfig,
  startProjectConfig,
  ConfigError,
  DEFAULT_ACCEPTANCE_GLOBS,
  gatesConfigHash,
  GATES_CONFIG_PATH,
  loadGatesConfig,
  parseGatesConfig,
  type CommittedGates,
  loadProjectConfig,
  pipelineConfigHash,
  PROJECT_CONFIG_PATH,
} from "./config.js";
export { parseYaml, toYaml, YamlError } from "./yaml.js";
export { clientSpendRow, readClientSpend, recordClientSpend } from "./spend.js";
export { LOOKBACK_ROLE, lookbackInputPath } from "./retro.js";
export { MAX_STEP_FAILURES } from "./submit.js";
export { RESUME_JITTER_MS, MAX_LIMIT_BACKOFFS } from "./limits.js";
export { INDEX_PATH, openEventIndex, type EventIndex } from "./event-index.js";
/**
 * Spine §5 readings 181 and 180: the cli pin gestures use the engine's table and replay rule, not
 * copies.
 */
export { HEADLESS_LOADS_AGENT, replayReach, roleChangesFiles } from "./prompt-target.js";
export { replayGraderOf, replayWaitSkipReason } from "./replay.js";
/**
 * Automatic issues and PRs (AD-27, contracts 5.0.0): the Automation read model, the engine facts
 * that trigger the upstream module (D-bv), the daily summary, and the seam the daemon drives the
 * module through (`CreateUpstream`; the module reaches core only through this index, rule 8).
 */
export {
  AUTOMATION_OFF_NOTE,
  automationDailySummary,
  automationFacts,
  automationReportView,
  isAutomationEvent,
  type AutomationFact,
  type CreateUpstream,
  type UpstreamWiring,
  type UpstreamWiringDeps,
} from "./automation.js";
export { readModelState, replayTrialActionIds, withoutReplayTrialEvents } from "./replay-view.js";
