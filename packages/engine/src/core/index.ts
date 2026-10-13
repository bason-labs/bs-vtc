/**
 * Engine core (AD-13; owner: engine-core team, sub-project 1): state, events, scheduler, loops,
 * budgets, triage, escalation, merge queue, tracing. Reaches the Gate Runner only through the
 * `GateRunner` interface and git only through `../git/index.ts`.
 */
export {
  acquireEngineLock,
  EngineLockedError,
  type AcquireLockOptions,
  type EngineLock,
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
export { EngineError, type CallContext, type EngineCoreDeps, type RunHandle } from "./kernel.js";
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
} from "./plugins.js";
export { guardDirFor, GUARD_DIR } from "./guard.js";
export { EngineWrites, type WriteCheck } from "./engine-writes.js";
export { ENGINE_FILE_DIRS, FORENSICS_DIR, type DispatchRecord } from "./dispatch-guard.js";
export { roleWorktreeId, ROLE_INPUT_DIRS } from "./role-worktree.js";
export { FINAL_REVIEW_STEPS_RUN } from "./projections.js";
export { architectDepth, dealDesignConstraints, LOTTERY_POOLS, researchDepth } from "./lottery.js";
export {
  ConfigError,
  DEFAULT_ACCEPTANCE_GLOBS,
  GATES_CONFIG_PATH,
  loadGatesConfig,
  loadProjectConfig,
  pipelineConfigHash,
  PROJECT_CONFIG_PATH,
} from "./config.js";
export { parseYaml, toYaml, YamlError } from "./yaml.js";
export { MAX_STEP_FAILURES } from "./submit.js";
export { RESUME_JITTER_MS, MAX_LIMIT_BACKOFFS } from "./limits.js";
export { INDEX_PATH, openEventIndex, type EventIndex } from "./event-index.js";
