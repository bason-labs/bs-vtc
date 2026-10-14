/**
 * Lookback (spec §13; spine AD-21; lookback-research team). It reaches engine core only through
 * `core/index.ts` and the gates only through the `GateRunner` interface. The daemon
 * (`wireLookback`, spine §5 reading 144) hands core {@link createPromptPins} as its synchronous
 * prompt selector, calls {@link evaluateCanaries} as canary dispatches end, and calls
 * {@link lookbackAtRunEnd} at `run.finished` (attributions and scorecards), and hands core
 * {@link createLookbackRetro} for RETRO (spine §5 reading 154): before the run finishes, the
 * lookback role is queued for the targets `lookbackAtRunEnd` returns, reading the input
 * {@link renderLookbackInput} writes, and {@link checkProposal} runs when it submits.
 * Replays (AD-21 rule 6, spine §5 reading 176): engine-core's runner dispatches the
 * `lookback_replay` trials {@link planReplayTrials} plans, grades each with {@link gradeTrial},
 * decides with {@link finishReplay} and writes the result with {@link writeReplayResult} (whose
 * `lookback.replay_finished` carries the SHA-256 of the bytes written), reading the A/A noise
 * floor with {@link cachedAaFlipRate} and keeping a measured one with {@link recordAaFlipRate}.
 * AI tiebreak answers are recorded with {@link appendTiebreakRecord} under the VTC home; only
 * those {@link readTiebreakKeys} returns let an `ai_tiebreak` attribution count.
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
  createPromptPins,
  EMPTY_PINS,
  pinsPath,
  readPins,
  readPinsSync,
  selectPromptVersion,
  selectPromptVersionSync,
  type CompiledPrompt,
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
export {
  createLookbackRetro,
  renderLookbackInput,
  type CompiledTexts,
  type LookbackRetroDeps,
} from "./retro.js";
export { computeScorecards, writeScorecards } from "./scorecards.js";
export { appendTiebreakRecord, readTiebreakKeys, tiebreaksPath } from "./tiebreaks.js";
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
  loadPromptVersionSync,
  promptVersionPath,
  PromptVersionError,
  promptVersionRef,
  sectionSha,
  storePromptVersion,
} from "./versions.js";
