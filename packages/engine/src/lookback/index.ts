/**
 * Lookback (spec §13; spine AD-21; lookback-research team). It reaches engine core only through
 * `core/index.ts` and the gates only through the `GateRunner` interface. The daemon
 * (`wireLookback`, spine §5 reading 144) hands core {@link createPromptPins} as its synchronous
 * prompt selector, calls {@link evaluateCanaries} as canary dispatches end, and calls
 * {@link lookbackAtRunEnd} at `run.finished` (attributions and scorecards), and hands core
 * {@link createLookbackRetro} for RETRO (spine §5 reading 154): before the run finishes, the
 * lookback role is queued for the targets `lookbackAtRunEnd` returns, reading the input
 * {@link renderLookbackInput} writes, and {@link checkProposal} runs when it submits.
 * Replays (AD-21 rule 6, spine §5 readings 176, 201 and 202): engine-core's runner plans the
 * `lookback_replay` trials of each proposal ({@link replayTasks} with the role's grader,
 * {@link planReplayTrials}; the sample and the trial cap at the replay pace, `lookbackPaceFor`,
 * D-cq), launches what {@link planRetroReplays} allows this RETRO (a grader that can score the
 * role, the weekly window, the budget and the pace's trial cap, each limit an
 * `automation.skipped` draft), grades each trial with {@link gradeTrial} (the gates) or
 * {@link gradeVerdictReplay} (a verdict role against the expectation its task key carries,
 * {@link expectedOfTaskKey}; `infra_error` when the replayed dispatch has no recorded outcome), keeps
 * every grade in the trial ledger ({@link recordReplayTrial}) so a replay continues across RETROs,
 * and once all are graded builds the result with {@link assembleReplay} (its grader and isolation
 * recorded)
 * and writes it with {@link writeReplayResult} (whose `lookback.replay_finished` carries the
 * SHA-256 of the bytes written), reading the A/A noise floor with {@link cachedAaFlipRate} and
 * keeping a measured one with {@link recordAaFlipRate}. Engine core's `LookbackRetro` seam does not
 * drive {@link planRetroReplays} and the ledger yet (core caps whole replays itself and has no
 * per-trial outcome hook): a contract proposal to engine core and the daemon owner, see the
 * `replay-ledger` module comment.
 * At the run's end Lookback also returns what engine core hands the upstream module: cost
 * regressions ({@link costRegressions}, D-bv; their lookback target is aimed at tokens) and
 * missing specialists ({@link newAgentSignals}, D-cd, evidence-only), with the VTC-side report
 * fields of each ({@link costReportFields}, {@link newAgentReportFields}); an `improve` verdict's
 * fields ({@link improvementReportFields}) open the bs-vtc PR.
 * AI tiebreak answers are recorded with {@link appendTiebreakRecord} under the VTC home; only
 * those {@link readTiebreakKeys} returns let an `ai_tiebreak` attribution count.
 * Promotion (D-cb, spine §5 reading 196): for everyone, the human's merge of the bs-vtc PR an
 * `improve` opens; on one machine, the cli's `vtc lookback approve|pin|rollback` (a local canary),
 * never an MCP tool. The engine may only roll a canary back.
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
export {
  COST_TRACES_MAX,
  costRegressions,
  type CostMetric,
  type CostRegression,
  type CostTrace,
} from "./cost-regression.js";
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
  NEW_AGENT_MIN_ESCALATIONS,
  newAgentSignals,
  type InstalledRole,
  type NewAgentSignal,
} from "./new-agent.js";
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
  replayIsolation,
  replayPath,
  expectedOfTaskKey,
  replayTaskKey,
  replayTasks,
  tokensDeltaPct,
  writeReplayResult,
  type ReplayTask,
  type ReplayTrial,
} from "./replay.js";
export {
  assembleReplay,
  readReplayInfra,
  readReplayLedger,
  readReplayTrials,
  recordReplayInfra,
  recordReplayTrial,
  REPLAY_INFRA_OUTCOMES,
  REPLAY_MAX_INFRA_ATTEMPTS,
  REPLAY_TRIALS_FILE,
  replayTrialKey,
  type ReplayInfraAttempts,
  type ReplayInfraOutcome,
  type ReplayInfraRow,
  type ReplayLedger,
  type ReplayLedgerScope,
  type ReplayTrialId,
  type ReplayTrialRow,
} from "./replay-ledger.js";
export {
  planRetroReplays,
  REPLAY_LIMIT_REASONS,
  replayLimitReason,
  replaySkippedEvent,
  type AutomationSkippedDraft,
  type LaunchedReplay,
  type PendingReplay,
  type ReplayLimitReason,
} from "./replay-plan.js";
export {
  costReportFields,
  improvementReportFields,
  newAgentReportFields,
  type LookbackReportFields,
} from "./reports.js";
export {
  LOOKBACK_MAX_TRACES,
  lookbackAtRunEnd,
  lookbackTargets,
  type HumanEditDiff,
  type LookbackDispatched,
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
export {
  computeRoutingScorecard,
  routedStartTier,
  routingProposals,
  routingReplayTasks,
  writeRoutingScorecard,
  type RoutingCell,
  type RoutingChange,
  type RoutingConfigFact,
  type RoutingProposals,
  type RoutingTierReplay,
} from "./routing.js";
export { computeScorecards, writeScorecards, type TimeWindow } from "./scorecards.js";
export {
  appendTiebreakRecord,
  readTiebreakKeys,
  TIEBREAK_STORE_MAX_BYTES,
  tiebreakRecordFor,
  tiebreaksPath,
  type TiebreakAnswer,
} from "./tiebreaks.js";
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
  gradeVerdictReplay,
  gradeVerdictTrial,
  recordedOutcome,
  VERDICT_GRADER_VERSION,
  type ExpectedVerdict,
  type RecordedOutcome,
  type RecordedOutcomeSource,
} from "./verdict-grader.js";
export {
  loadPromptVersion,
  loadPromptVersionSync,
  promptVersionPath,
  PromptVersionError,
  promptVersionRef,
  sectionSha,
  storePromptVersion,
} from "./versions.js";
