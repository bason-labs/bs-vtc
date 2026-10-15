/**
 * Lookback's routing step at RETRO (D-cn; spine §5 readings 219 and 247(6)).
 * {@link lookbackRoutingStep} fits engine core's `RoutingLookback` seam
 * (`wireLookback(..., { propose, found })`), through which the daemon calls it at RETRO and turns
 * each cell it returns into a `config` improvement fact (`routingConfigFact`) for the upstream
 * module (the AD-27 issue -> PR path; the PR changes only the values of `DEFAULT_ROUTING_TABLE`).
 *
 * The step recomputes the routing scorecard from the history (`computeRoutingScorecard`), writes it
 * at `LOOKBACK_REPO.routingScorecard` when it has a cell, and decides what backs each change
 * `routingProposals` makes (producer cells only, D-cu). A change the table cannot make alone
 * (`RoutingProposals.dropped`) is no cell of the seam; the scorecard written here keeps its
 * evidence.
 *
 * **Tier replays** (reading 247(6)). Given the RETRO's trial budget (`trialBudget`: what is left of
 * the D-cq per-RETRO cap, `lookbackPaceFor`, after the prompt replays), the VTC home and the locked
 * prompt sections, each change, in the proposals' order, gets one of:
 * - _graded_: the replay ledger holds every trial of its tier replay (`routing-replay.ts`) under the
 *   prompt version the role runs now and the current grader bundle: the step grades it
 *   (`assembleRoutingReplay`), writes the `RoutingReplayResult`, and raises the fact with the verdict
 *   only when `routingReplayBacks(direction, verdict)`; otherwise no fact for the window;
 * - _running_: some of its trials are graded, or the budget has room for at least one whole pair:
 *   the trials that fit are returned to launch (`replays`, whole pairs within the budget, which
 *   each launch draws down) and no fact is raised until the replay is graded; a replay continues
 *   at the next RETRO from what the ledger holds;
 * - _scorecard alone_ (`routing.replay_planned` 0, as before 5.7.0): no budget for a new replay,
 *   no held-out task to replay, no prompt version known for the role, or a trial that measured
 *   nothing `REPLAY_MAX_INFRA_ATTEMPTS` times.
 * Without a trial budget (or the VTC home, or the locked sections) every change carries the
 * scorecard alone. The roles of one shared change move together: when any of them is withheld,
 * none of the shared change's facts is raised, so a shared cell never moves on part of its
 * evidence.
 *
 * The replays come back on the returned cells (`RoutingStepCells.replays`) so the result still
 * fits the seam's cell list; engine core launches them as `lookback_replay` trials on their arm's
 * tier (`ReplayTrialRef.tier`) and records each outcome with `recordRoutingReplayTrial`.
 */
import {
  DEFAULT_ROUTING_TABLE,
  engineRepoKey,
  replayGraderFor,
  routingReplayBacks,
  routingReplayId,
  type LookbackPace,
  type PromptVersionRef,
  type RoutingTable,
  type VtcEvent,
} from "@vtc/shared";
import { readAttributions } from "./attribution.js";
import { readReplayLedger, REPLAY_MAX_INFRA_ATTEMPTS, replayTrialKey } from "./replay-ledger.js";
import { ungradedTrialGroups } from "./replay-plan.js";
import { cachedAaFlipRate } from "./replay.js";
import {
  computeRoutingScorecard,
  routingProposalCells,
  routingProposals,
  routingReplayTasks,
  writeRoutingScorecard,
  type RoutingChange,
  type RoutingEvidence,
  type RoutingProposalCell,
} from "./routing.js";
import {
  assembleRoutingReplay,
  planRoutingReplayTrials,
  routingReplayCosts,
  routingReplayScope,
  writeRoutingReplayResult,
  type RoutingReplayLaunch,
  type RoutingReplayTrial,
} from "./routing-replay.js";
import { readTiebreakKeys } from "./tiebreaks.js";
import { buildTraces, sameTarget, type LockedShaFor, type Trace } from "./traces.js";

/** The cells to raise, with the tier replay trials this RETRO launches. */
export type RoutingStepCells = RoutingProposalCell[] & {
  readonly replays: readonly RoutingReplayLaunch[];
};

const withReplays = (
  cells: RoutingProposalCell[],
  replays: readonly RoutingReplayLaunch[],
): RoutingStepCells => Object.assign(cells, { replays });

/**
 * The prompt version `target` runs now: that of its latest dispatch in the history with a known
 * version, a canary's candidate arm left out (it is not the version in force).
 */
const currentPrompt = (
  traces: readonly Trace[],
  target: { readonly role: string; readonly mode?: string | undefined; readonly host: string },
): PromptVersionRef | undefined => {
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const t = traces[i];
    if (t?.prompt === undefined || t.canaryArm === "candidate" || !sameTarget(t, target)) continue;
    return t.prompt;
  }
  return undefined;
};

export const lookbackRoutingStep = async (input: {
  readonly projectRoot: string;
  /** Every run's events as Lookback reads them (replay trials are left out either way). */
  readonly history: readonly VtcEvent[];
  readonly graderBundleSha: string;
  readonly now: Date;
  /**
   * Given, the trusted rows of `.vtc/lookback/attributions.jsonl` decide which dispatches failed
   * (`tokens_per_success`), as at the run's end; absent, a submitted dispatch counts as a success.
   * A tier replay needs it too: it names the prompt version both arms run.
   */
  readonly lockedShaFor?: LockedShaFor;
  /** The VTC home: its recorded AI tiebreaks let an `ai_tiebreak` row count; its replay ledger. */
  readonly vtcHome?: string;
  /** The table the runs routed with; default `DEFAULT_ROUTING_TABLE`. */
  readonly table?: RoutingTable;
  /**
   * The replay trials this RETRO may still launch (D-cq: `lookbackPaceFor`'s per-RETRO cap less
   * the prompt replays' trials). Absent: no tier replay; every change carries the scorecard alone.
   */
  readonly trialBudget?: number;
  /** How many failure and regression tasks one replay samples (D-cq); default `LOOKBACK_LIMITS`. */
  readonly pace?: Pick<LookbackPace, "failureTasks" | "regressionTasks">;
  /**
   * The replay trials' own events (`purpose: lookback_replay`, left out of `history`), whose
   * reported costs give a graded tier replay its `cost_delta_pct`. Absent: the cost is unknown.
   */
  readonly replayEvents?: readonly VtcEvent[];
}): Promise<RoutingStepCells> => {
  const table = input.table ?? DEFAULT_ROUTING_TABLE;
  const repoKey = engineRepoKey(input.projectRoot);
  const tiebreaks =
    input.lockedShaFor === undefined || input.vtcHome === undefined
      ? undefined
      : await readTiebreakKeys(input.vtcHome, repoKey);
  const attributions =
    input.lockedShaFor === undefined
      ? []
      : await readAttributions(input.projectRoot, {
          history: input.history,
          lockedShaFor: input.lockedShaFor,
          ...(tiebreaks === undefined ? {} : { tiebreaks }),
        });
  const card = computeRoutingScorecard({
    history: input.history,
    attributions,
    graderBundleSha: input.graderBundleSha,
    now: input.now,
    table,
  });
  if (card.cells.length === 0) return withReplays([], []);
  await writeRoutingScorecard(input.projectRoot, card);
  const proposals = routingProposals(card, table);
  const { vtcHome, lockedShaFor, trialBudget } = input;
  if (
    proposals.changes.length === 0 ||
    trialBudget === undefined ||
    vtcHome === undefined ||
    lockedShaFor === undefined
  )
    return withReplays(routingProposalCells(proposals), []);

  const ledger = await readReplayLedger(vtcHome);
  const traces = buildTraces(input.history, lockedShaFor);
  let budget = Math.max(0, Math.floor(trialBudget));
  const replays: RoutingReplayLaunch[] = [];
  const scorecard: RoutingEvidence = { kind: "scorecard" };

  /** One change's evidence (`null`: withheld) and the trials it launches now. */
  const tierReplay = async (change: RoutingChange): Promise<RoutingEvidence | null> => {
    const { current } = change;
    const target = {
      role: current.role,
      ...(current.mode === undefined ? {} : { mode: current.mode }),
      host: current.host,
    };
    const prompt = currentPrompt(traces, target);
    // the routed roles (D-cu: the Engineer family and QA author) change files: the gates grade
    const grader = replayGraderFor(change.role, true);
    if (prompt === undefined || grader === null) return scorecard;
    const tasks = routingReplayTasks({
      history: input.history,
      attributions,
      cell: current,
      table,
      ...(input.pace === undefined ? {} : { pace: input.pace }),
    });
    if (tasks.length === 0) return scorecard;
    const id = routingReplayId(change.role, change.size, change.risk, change.from, change.to);
    const planned = planRoutingReplayTrials({ tasks, from: change.from, to: change.to });
    const scope = routingReplayScope({
      repoKey,
      proposal: id,
      prompt: prompt.effective_sha256,
      graderBundleSha: input.graderBundleSha,
    });
    const rows = ledger.trials(scope);
    const aaFlipRate = await cachedAaFlipRate({
      vtcHome,
      repoKey,
      baseline: prompt,
      graderBundleSha: input.graderBundleSha,
    });
    const assembled = assembleRoutingReplay({
      id,
      subject: change.subject,
      target,
      prompt: prompt.effective_sha256,
      tiers: { a: change.from, b: change.to },
      grader,
      graderBundleSha: input.graderBundleSha,
      planned,
      rows,
      ...(aaFlipRate === undefined ? {} : { aaFlipRate }),
      ...(input.replayEvents === undefined
        ? {}
        : { costs: routingReplayCosts(input.replayEvents, id) }),
      now: input.now,
    });
    if (assembled.complete) {
      await writeRoutingReplayResult(input.projectRoot, assembled.result);
      return routingReplayBacks(change.direction, assembled.result.verdict)
        ? { kind: "replay", result: assembled.result }
        : null;
    }
    // a row counts for its arm's tier only (`assembleRoutingReplay`)
    const graded = new Set(
      planned
        .filter((t) => rows.get(replayTrialKey(t))?.tier === t.tier)
        .map((t) => replayTrialKey(t)),
    );
    const groups = ungradedTrialGroups(planned, graded);
    const infra = ledger.infra(scope);
    if (
      groups
        .flat()
        .some((t) => (infra.get(replayTrialKey(t))?.attempts ?? 0) >= REPLAY_MAX_INFRA_ATTEMPTS)
    )
      return scorecard;
    const launch: RoutingReplayTrial[] = [];
    let remaining = 0;
    for (const group of groups) {
      if (remaining === 0 && group.length <= budget) {
        launch.push(...group);
        budget -= group.length;
      } else remaining += group.length;
    }
    if (launch.length === 0 && graded.size === 0) return scorecard;
    if (launch.length > 0)
      replays.push({
        proposal: id,
        subject: change.subject,
        ...target,
        prompt,
        grader,
        trials: launch,
        remaining,
      });
    return null;
  };

  const evidence = new Map<RoutingChange, RoutingEvidence | null>();
  for (const change of proposals.changes) evidence.set(change, await tierReplay(change));
  // one shared change moves on all of its roles' evidence, or not at all
  const sharedKey = (c: RoutingChange) => `${c.size}.${c.risk}\n${c.direction}\n${c.to}`;
  const withheld = new Set(
    proposals.changes
      .filter((c) => c.scope === "shared" && evidence.get(c) === null)
      .map(sharedKey),
  );
  return withReplays(
    routingProposalCells(proposals, (c) => {
      if (c.scope === "shared" && withheld.has(sharedKey(c))) return null;
      const backing = evidence.get(c);
      return backing === undefined ? scorecard : backing;
    }),
    replays,
  );
};
