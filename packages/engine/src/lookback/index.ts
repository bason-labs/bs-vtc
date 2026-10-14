/**
 * Lookback (spec §13; spine AD-21; lookback-research team). It reaches engine core only through
 * `core/index.ts` and the gates only through the `GateRunner` interface. The daemon calls
 * {@link lookbackAtRunEnd} at `run.finished`, {@link selectPromptVersion} before each dispatch,
 * {@link evaluateCanaries} as canary dispatches end, and {@link checkProposal} when the lookback
 * role submits; replays run as `lookback_replay` dispatches it plans with {@link planReplayTrials}.
 * Human promotion is the cli's `vtc lookback approve|pin|rollback`, never an MCP tool.
 */
export {
  appendAttributions,
  attributeRun,
  attributionsPath,
  failureSignals,
  humanLabels,
  readAttributions,
  RULES_UPSTREAM_FIRST,
  tiebreakAttribution,
  TREE_CONFIDENCE,
  type AttributionResult,
  type FailureSignal,
} from "./attribution.js";
export { canaryArmStats, evaluateCanaries } from "./canary.js";
export { lookbackEvent, type LookbackEventDraft, type LookbackEventType } from "./events.js";
export { graderBundleSha, LOOKBACK_METRICS_VERSION, type GraderBundle } from "./grader-bundle.js";
export {
  autoRollback,
  canaryAssignedEvent,
  checkEngineWrite,
  EMPTY_PINS,
  pinsPath,
  readPins,
  selectPromptVersion,
  type PinsRead,
  type PinTarget,
  type PromptSelection,
} from "./pins.js";
export {
  candidateFrontmatter,
  checkProposal,
  proposalPaths,
  proposalRecordedEvent,
  readProposalFiles,
  type ProposalCheck,
} from "./proposals.js";
export {
  aaFlipRate,
  cachedAaFlipRate,
  finishReplay,
  gradeTrial,
  planReplayTrials,
  replayDispatchPlan,
  REPLAY_MAX_TASKS,
  replayPath,
  replayTasks,
  tokensDeltaPct,
  writeReplayResult,
  type ReplayTask,
  type ReplayTrial,
} from "./replay.js";
export {
  LOOKBACK_MAX_TRACES,
  lookbackAtRunEnd,
  lookbackTargets,
  type LookbackSkipReason,
  type LookbackTarget,
  type RunEndResult,
} from "./run-end.js";
export { computeScorecards, writeScorecards } from "./scorecards.js";
export {
  buildTraces,
  sameTarget,
  targetKey,
  traceRef,
  type LockedShaFor,
  type Trace,
  type TraceEnd,
} from "./traces.js";
export {
  loadPromptVersion,
  promptVersionPath,
  PromptVersionError,
  promptVersionRef,
  sectionSha,
  storePromptVersion,
} from "./versions.js";
