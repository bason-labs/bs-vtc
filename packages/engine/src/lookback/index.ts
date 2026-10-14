/**
 * Lookback (spec §13; spine AD-21; lookback-research team). It reaches engine core only through
 * `core/index.ts` and the gates only through the `GateRunner` interface. The daemon calls
 * {@link lookbackAtRunEnd} at `run.finished`, {@link selectPromptVersion} before each dispatch,
 * {@link evaluateCanaries} as canary dispatches end, and {@link checkProposal} when the lookback
 * role submits; replays run as `lookback_replay` dispatches it plans with {@link planReplayTrials},
 * reading the A/A noise floor with {@link cachedAaFlipRate} and keeping a measured one with
 * {@link recordAaFlipRate}.
 * Human promotion is the cli's `vtc lookback approve|pin|rollback`, never an MCP tool.
 */
export {
  appendAttributions,
  attributeRun,
  attributionsPath,
  failureSignals,
  humanLabels,
  isRoleFailure,
  isTrainFailure,
  readAttributions,
  RULES_UPSTREAM_FIRST,
  tiebreakAttribution,
  tiebreakKey,
  TREE_CONFIDENCE,
  trustedAttributions,
  type AttributionHistory,
  type AttributionResult,
  type FailureSignal,
} from "./attribution.js";
export { canaryArmStats, evaluateCanaries } from "./canary.js";
export { lookbackEvent, type LookbackEventDraft, type LookbackEventType } from "./events.js";
export {
  capDiff,
  HUMAN_EDIT_DIFF_MAX_CHARS,
  humanEdits,
  LOOKBACK_MAX_HUMAN_EDITS,
  type HumanEdit,
} from "./human-edits.js";
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
  PROPOSAL_FILE_MAX_BYTES,
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
  recordAaFlipRate,
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
  type HumanEditDiff,
  type LookbackHumanEdit,
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
  traceSlug,
  traceSplit,
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
