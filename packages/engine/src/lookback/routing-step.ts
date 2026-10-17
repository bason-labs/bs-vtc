/**
 * Lookback's routing step at RETRO (D-cn; spine §5 readings 219, 247(6) and 250), in two forms:
 * - {@link routingReplayStep} fits engine core's `RoutingLookback` seam: the daemon calls it inside
 *   RETRO's replay planning (`wireLookback(..., { propose, found })`), launches the tier replay
 *   trials it returns as `lookback_replay` trials on their arm's tier, records each outcome with
 *   `recordRoutingReplayTrial`, logs `skipped`, hands every run's tier replay trial events back at
 *   the next RETRO, and turns each cell it returns into a `config` improvement fact
 *   (`routingConfigFact`) for the upstream module (the AD-27 issue -> PR path; the PR changes only
 *   the values of `DEFAULT_ROUTING_TABLE`).
 * - {@link lookbackRoutingStep} is the same step for a caller that launches no tier replay (no
 *   trial budget, no trial events): a graded replay still decides its change, a started one still
 *   holds its fact, and the others carry the scorecard alone (`routing.replay_planned` 0).
 *
 * Both recompute the routing scorecard from the history (`computeRoutingScorecard`), write it at
 * `LOOKBACK_REPO.routingScorecard` when it has a cell, and decide what backs each change
 * `routingProposals` makes (producer cells only, D-cu). A change the table cannot make alone
 * (`RoutingProposals.dropped`) is no cell; the scorecard written here keeps its evidence.
 *
 * **Tier replays** (reading 247(6), {@link routingReplayStep}). Given the VTC home and the locked
 * prompt sections, each change, in the proposals' order, gets one of:
 * - _graded_: the replay ledger holds every trial of its tier replay (`routing-replay.ts`) under the
 *   prompt version the role runs now and the current grader bundle, and the replay trials' events
 *   show each of them ran on its arm's tier: the step grades it (`assembleRoutingReplay`), writes
 *   the `RoutingReplayResult`, and raises the fact with the verdict only when
 *   `routingReplayBacks(direction, verdict)`; otherwise no fact for the window. A graded replay
 *   decides whatever the trial budget, so a RETRO without one never raises the scorecard fact a
 *   graded replay refused;
 * - _running_: the replay has started (the ledger holds a grade or an attempt of one of its
 *   trials), or the RETRO's trial budget (`trialBudget`: what is left of the D-cq per-RETRO cap,
 *   `lookbackPaceFor`, after the prompt replays; absent counts as none) has room for at least one
 *   whole pair: the trials that fit are returned to launch (`replays`, whole pairs within the
 *   budget, which each launch draws down) and no fact is raised until the replay is graded; a
 *   replay continues at the next RETRO from what the ledger holds, and one whose trials wait for a
 *   later RETRO logs `automation.skipped` `trial_cap`. The sample is drawn again from the history
 *   at every RETRO (`routingReplayTasks`, first held-out tasks in log order): while a bucket is
 *   below its pace cap a new held-out task joins it, so a replay graded at one RETRO reopens at a
 *   later one (its fact withheld again and the new task's trials launched) and is graded anew once
 *   they are; the result already written stays until then;
 * - _scorecard alone_ (`routing.replay_planned` 0, as before 5.7.0): no budget for a new replay, no
 *   held-out task to replay, no prompt version known for the role, or no replay id for the role
 *   (`routingReplayId`'s length bound);
 * - _withheld, stopped_ (reading 249): a started replay that cannot be graded: a trial that
 *   measured nothing `REPLAY_MAX_INFRA_ATTEMPTS` times (`automation.skipped` `plugin_locked` when
 *   a plugin lock was the cause), or a trial not known to have run on its arm's tier: a dispatch of
 *   it off that tier in `replayEvents` (`routingReplayTrialTiers`: another tier or none, clamped by
 *   the project's bounds, moved by a model fallback), a ledger row of another tier, or a graded
 *   trial with no on-tier dispatch in `replayEvents`. Such a replay is not graded and not launched
 *   again (fail closed: its trials could measure the same model on both arms and pass for a replay
 *   that backs the change), and its change raises no fact on the scorecard alone either, until a
 *   new prompt version or grader bundle starts the replay over. Only the dispatches of the
 *   replay's own scope count: its prompt version (`prompt_sha`) and grader bundle
 *   (`ReplayTrialRef.grader_bundle_sha`; a dispatch without one counts for every bundle).
 * Without the VTC home or the locked sections every change carries the scorecard alone.
 *
 * **Shared changes.** The roles of one shared change move together: when any of them is withheld
 * (its replay runs, or was graded and does not back the change), none of the shared change's facts
 * is raised. A role whose replay cannot run (the scorecard-alone cases above) does not hold the
 * others: its fact carries its scorecard evidence (`routing.replay_planned` 0) beside the other
 * roles' graded replays, since requiring a replay from it would block the shared cell for good.
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
import {
  replaySkippedEvent,
  ungradedTrialGroups,
  type AutomationSkippedDraft,
} from "./replay-plan.js";
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
  routingReplayTrialTiers,
  routingReplayScope,
  writeRoutingReplayResult,
  type RoutingReplayLaunch,
  type RoutingReplayTrial,
} from "./routing-replay.js";
import { readTiebreakKeys } from "./tiebreaks.js";
import { buildTraces, sameTarget, type LockedShaFor, type Trace } from "./traces.js";

/**
 * What {@link routingReplayStep} returns: the cells to raise, the tier replay trials this RETRO
 * launches and the `automation.skipped` drafts (D-cg) for the caller to log.
 */
export interface RoutingStepResult {
  readonly cells: readonly RoutingProposalCell[];
  readonly replays: readonly RoutingReplayLaunch[];
  readonly skipped: readonly AutomationSkippedDraft[];
}

/** The input both forms of the step share: what engine core's `RoutingLookback` seam passes. */
export interface RoutingStepInput {
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
  /** How many failure and regression tasks one replay samples (D-cq); default `LOOKBACK_LIMITS`. */
  readonly pace?: Pick<LookbackPace, "failureTasks" | "regressionTasks">;
}

const done = (
  cells: RoutingProposalCell[],
  replays: readonly RoutingReplayLaunch[] = [],
  skipped: readonly AutomationSkippedDraft[] = [],
): RoutingStepResult => ({ cells, replays, skipped });

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

/** `routingReplayId`, or `undefined` for a role id too long for the replay id (a slug). */
const replayIdOf = (change: RoutingChange): string | undefined => {
  try {
    return routingReplayId(change.role, change.size, change.risk, change.from, change.to);
  } catch {
    return undefined;
  }
};

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

/**
 * The tier replays of one RETRO: what is left of its trial budget, and the tier replay trials'
 * own events of every run (where each trial ran and what it cost).
 */
interface Tiered {
  readonly trialBudget: number;
  readonly events: readonly VtcEvent[];
}

const routingStep = async (input: RoutingStepInput, tiered: Tiered): Promise<RoutingStepResult> => {
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
  if (card.cells.length === 0) return done([]);
  await writeRoutingScorecard(input.projectRoot, card);
  const proposals = routingProposals(card, table);
  const { vtcHome, lockedShaFor } = input;
  if (proposals.changes.length === 0 || vtcHome === undefined || lockedShaFor === undefined)
    return done(routingProposalCells(proposals));

  const ledger = await readReplayLedger(vtcHome);
  const traces = buildTraces(input.history, lockedShaFor);
  let budget = Math.max(0, Math.floor(tiered.trialBudget));
  const replays: RoutingReplayLaunch[] = [];
  const skipped: AutomationSkippedDraft[] = [];
  let waiting = 0;
  let waitingReplays = 0;
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
    const id = replayIdOf(change);
    if (id === undefined) return scorecard;
    const planned = planRoutingReplayTrials({ tasks, from: change.from, to: change.to });
    const scope = routingReplayScope({
      repoKey,
      proposal: id,
      prompt: prompt.effective_sha256,
      graderBundleSha: input.graderBundleSha,
    });
    const rows = ledger.trials(scope);
    // a trial not known to have run on its arm's tier measures nothing this replay compares (both
    // arms could have run one model); the ledger keeps a trial's first row, and its row carries
    // the arm's tier the caller named, so the trials' own dispatches of this scope (its prompt
    // version and grader bundle, reading 249) decide: the replay stops. A replay that stops after
    // it started never lets the scorecard alone raise its change (reading 247(6): the fact waits
    // for a graded replay that backs it): the change is withheld until a new prompt version or
    // grader bundle starts the replay over
    const eventScope = { prompt: prompt.effective_sha256, graderBundleSha: input.graderBundleSha };
    const ran = routingReplayTrialTiers(tiered.events, id, eventScope);
    if (
      planned.some((t) => {
        const key = replayTrialKey(t);
        const row = rows.get(key);
        return (
          ran.offTier.has(key) ||
          (row !== undefined && (row.tier !== t.tier || !ran.onTier.has(key)))
        );
      })
    )
      return null;
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
      costs: routingReplayCosts(tiered.events, id, eventScope),
      now: input.now,
    });
    if (assembled.complete) {
      await writeRoutingReplayResult(input.projectRoot, assembled.result);
      return routingReplayBacks(change.direction, assembled.result.verdict)
        ? { kind: "replay", result: assembled.result }
        : null;
    }
    const graded = new Set(planned.map((t) => replayTrialKey(t)).filter((key) => rows.has(key)));
    const groups = ungradedTrialGroups(planned, graded);
    const infra = ledger.infra(scope);
    const stuck = groups
      .flat()
      .map((t) => infra.get(replayTrialKey(t)))
      .find((a) => a !== undefined && a.attempts >= REPLAY_MAX_INFRA_ATTEMPTS);
    if (stuck !== undefined) {
      if (stuck.outcome === "plugin_locked")
        skipped.push(
          replaySkippedEvent(
            "plugin_locked",
            `the tier replay of ${id} stops: a managed-settings lock kept the installed vtc plugin on ${String(REPLAY_MAX_INFRA_ATTEMPTS)} attempts of one trial; its change is withheld until a new prompt version or grader bundle starts the replay over`,
          ),
        );
      // a started replay (its trials have attempts) that cannot finish withholds its change
      return null;
    }
    const started = graded.size > 0 || planned.some((t) => infra.has(replayTrialKey(t)));
    const launch: RoutingReplayTrial[] = [];
    let remaining = 0;
    for (const group of groups) {
      if (remaining === 0 && group.length <= budget) {
        launch.push(...group);
        budget -= group.length;
      } else remaining += group.length;
    }
    if (launch.length === 0 && !started) return scorecard;
    if (remaining > 0) {
      waiting += remaining;
      waitingReplays += 1;
    }
    if (launch.length > 0)
      replays.push({
        proposal: id,
        subject: change.subject,
        ...target,
        prompt,
        grader,
        graderBundleSha: input.graderBundleSha,
        trials: launch,
        remaining,
      });
    return null;
  };

  const evidence = new Map<RoutingChange, RoutingEvidence | null>();
  for (const change of proposals.changes) evidence.set(change, await tierReplay(change));
  if (waiting > 0)
    skipped.push(
      replaySkippedEvent(
        "trial_cap",
        `${plural(waiting, "tier replay trial")} of ${plural(waitingReplays, "routing change")} wait for the next RETRO: this RETRO's trial budget is spent`,
      ),
    );
  // one shared change moves on all of its roles' evidence, or not at all
  const sharedKey = (c: RoutingChange) => `${c.size}.${c.risk}\n${c.direction}\n${c.to}`;
  const withheld = new Set(
    proposals.changes
      .filter((c) => c.scope === "shared" && evidence.get(c) === null)
      .map(sharedKey),
  );
  return done(
    routingProposalCells(proposals, (c) => {
      if (c.scope === "shared" && withheld.has(sharedKey(c))) return null;
      const backing = evidence.get(c);
      return backing === undefined ? scorecard : backing;
    }),
    replays,
    skipped,
  );
};

/**
 * The routing step for a caller that launches no tier replay: {@link routingReplayStep} with no
 * trial budget and no trial events, the cells only. Nothing is launched: a graded replay still
 * decides its change, a started one (its ledger rows are not known to have run on their arm's
 * tier without the trials' events) still holds its fact, and every other change carries the
 * scorecard alone (`routing.replay_planned` 0).
 */
export const lookbackRoutingStep = async (
  input: RoutingStepInput,
): Promise<RoutingProposalCell[]> => [
  ...(await routingStep(input, { trialBudget: 0, events: [] })).cells,
];

/**
 * The routing step with tier replays, engine core's `RoutingLookback` seam. The caller launches
 * every trial of the returned `replays` as a `lookback_replay` trial on its arm's tier
 * (`ReplayTrialRef.tier`, with `ReplayTrialRef.grader_bundle_sha`), records each outcome with
 * `recordRoutingReplayTrial`, logs `skipped`, and at every RETRO passes the events of every tier
 * replay trial it has run for the project (`replayEvents`, from all runs, not only this
 * RETRO's): they show where each trial ran and what it cost, and a replay whose graded trials
 * they do not show on their arm's tier is never graded. A caller that launches trials and never
 * records them keeps their changes' facts withheld.
 */
export const routingReplayStep = async (
  input: RoutingStepInput & {
    /**
     * The replay trials this RETRO may still launch (D-cq: `lookbackPaceFor`'s per-RETRO cap less
     * the prompt replays' trials). Absent counts as 0: no trial is launched, but a graded replay
     * still decides its change and a started one still holds its fact.
     */
    readonly trialBudget?: number;
    /**
     * The tier replay trials' own events (`purpose: lookback_replay`, left out of `history`), of
     * every run: their dispatched tiers show whether each trial ran on its arm's tier
     * (`routingReplayTrialTiers`) and their reported costs give a graded replay its
     * `cost_delta_pct`.
     */
    readonly replayEvents: readonly VtcEvent[];
  },
): Promise<RoutingStepResult> =>
  routingStep(input, { trialBudget: input.trialBudget ?? 0, events: input.replayEvents });
