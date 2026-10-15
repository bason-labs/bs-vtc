/**
 * Which replay trials a RETRO launches (D-cg, D-ch; spine §5 readings 201 and 202; AD-21 rules 6
 * and 8). Pure: engine core's runner hands it every pending replay with its full trial plan
 * (`planReplayTrials`) and the trials the ledger already graded (`readReplayTrials`), and launches
 * what it returns.
 * - **Grader.** A replay runs only when a grader can score its role (`replayGraderFor`): `gates`
 *   for a role that changes files, on either host (on Claude Code each arm runs its own plugin),
 *   `verdict` for a role in `VERDICT_GRADED_ROLES`. Any other is left out with its reason.
 * - **Limits.** Replay trials are engine-launched headless runs bounded by the Lead host's weekly
 *   window, the Lookback budget and the per-RETRO trial cap of the replay pace (D-cq, spine §5
 *   reading 224, `lookbackPaceFor` of the user's `~/.vtc/config.yaml` `lookback`): 24 trials, or 36
 *   while more than half of the Lead host's weekly window is left.
 *   When a limit is hit, what is left waits for the next RETRO and the run logs
 *   `automation.skipped` with the limit's reason (`weekly_window`, `budget`, `trial_cap`).
 * - **Order.** Oldest replay first (by `PendingReplay.recordedAt`, the proposal's
 *   `lookback.proposal_recorded` time; ties keep the caller's order), each one's trials in plan
 *   order (interleaved arms), in whole
 *   groups (one task's trial number across its arms), so a pair is never split across RETROs. A
 *   replay whose trials are all graded comes back with none to run, whatever the limits: it is
 *   ready to finish (`assembleReplay`).
 * - **Unreplayable.** A replay is never launched, and comes back in `unreplayable` with its reason,
 *   when no grader can score its role, when its plan has no trial (the baseline has no held-out
 *   task to replay: for a verdict role, none with a recorded outcome), or when one of its trials
 *   measured nothing (`gate_infra`, `plugin_locked`, `no_outcome`) `REPLAY_MAX_INFRA_ATTEMPTS`
 *   times; the last
 *   also logs `automation.skipped` `plugin_locked` when the lock was the cause. The caller ends
 *   such a replay (it is no longer pending), so each is reported once.
 *
 * Engine core's RETRO runner (`daemon/replays.ts`) calls this each RETRO; it applies no trial cap
 * of its own, so this is the one cap (see the `replay-ledger` module comment).
 */
import {
  LOOKBACK_LIMITS,
  lookbackPaceFor,
  replayGraderFor,
  type AutomationSkipReason,
  type HostId,
  type ReplayGrader,
  type UserConfig,
} from "@vtc/shared";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import {
  REPLAY_MAX_INFRA_ATTEMPTS,
  replayTrialKey,
  type ReplayInfraOutcome,
  type ReplayTrialId,
} from "./replay-ledger.js";

/** The limits a replay waits on, as `automation.skipped` reasons (D-cg). */
export type ReplayLimitReason = Extract<
  AutomationSkipReason,
  "weekly_window" | "budget" | "trial_cap"
>;

/** Every reason a replay waits for the next RETRO. */
export const REPLAY_LIMIT_REASONS: readonly ReplayLimitReason[] = [
  "weekly_window",
  "budget",
  "trial_cap",
];

/**
 * Pure (AD-21 rule 8): why no replay trial may run now, or `null`. The weekly window of the run's
 * Lead host first (at least `LOOKBACK_LIMITS.minWeeklyRemainingPct` left; unknown waits), then the
 * Lookback budget.
 */
export const replayLimitReason = (input: {
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
}): Exclude<ReplayLimitReason, "trial_cap"> | null => {
  if (
    input.weeklyRemainingPct === null ||
    input.weeklyRemainingPct < LOOKBACK_LIMITS.minWeeklyRemainingPct
  )
    return "weekly_window";
  return input.budgetAvailable ? null : "budget";
};

/** An `automation.skipped` draft. */
export type AutomationSkippedDraft = Extract<
  LookbackEventDraft,
  { readonly type: "automation.skipped" }
>;

/**
 * The `automation.skipped` draft of a replay that waits (kind `lookback`): a limit, or
 * `plugin_locked` for a trial whose arm plugin the host did not prove it loaded (reading 201: a
 * managed-settings lock kept the installed plugin, so the trial is `gate_infra`, never a verdict).
 */
export const replaySkippedEvent = (
  reason: ReplayLimitReason | "plugin_locked",
  detail: string,
): AutomationSkippedDraft =>
  lookbackEvent("automation.skipped", {
    reason,
    kind: "lookback",
    detail: detail.slice(0, 500),
  });

/** One replay waiting to run: its target, whether its role changes files, its full trial plan. */
export interface PendingReplay<T extends ReplayTrialId> {
  readonly proposal: string;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  /** When the proposal was recorded (`lookback.proposal_recorded`, ISO): older replays go first. */
  readonly recordedAt: string;
  /** The engine's `roleChangesFiles` for the role (and mode). */
  readonly changesFiles: boolean;
  readonly trials: readonly T[];
}

/** A replay to run in this RETRO: the trials to launch now and how many still wait after them. */
export interface LaunchedReplay<T extends ReplayTrialId> {
  readonly proposal: string;
  readonly role: string;
  readonly mode?: string;
  readonly host: HostId;
  readonly grader: ReplayGrader;
  /** In plan order; empty when every trial is graded (the replay is ready to finish). */
  readonly trials: readonly T[];
  /** Ungraded trials left for a later RETRO. */
  readonly remaining: number;
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

/** The ungraded trials of a plan in whole groups (one task's trial number across its arms). */
const groupsOf = <T extends ReplayTrialId>(trials: readonly T[], graded: ReadonlySet<string>) => {
  const groups: T[][] = [];
  let key: string | undefined;
  for (const t of trials) {
    if (graded.has(replayTrialKey(t))) continue;
    const groupKey = `${t.task}\n${String(t.trial)}`;
    const last = groups.at(-1);
    if (last !== undefined && groupKey === key) last.push(t);
    else groups.push([t]);
    key = groupKey;
  }
  return groups;
};

/** Pure: the replays this RETRO launches, the ones it never will, and the limits it hit. */
export const planRetroReplays = <T extends ReplayTrialId>(input: {
  readonly pending: readonly PendingReplay<T>[];
  /** The trial keys (`replayTrialKey`) the ledger already graded for a proposal. */
  readonly graded: (proposal: string) => ReadonlySet<string>;
  /** The ledger's attempts that measured nothing, by trial key (`readReplayInfra`); none when absent. */
  readonly infra?: (
    proposal: string,
  ) => ReadonlyMap<string, { readonly attempts: number; readonly outcome: ReplayInfraOutcome }>;
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
  /**
   * The user's config (`~/.vtc/config.yaml`), whose `lookback` section sets the replay pace; the
   * cap is `lookbackPaceFor(user, weeklyRemainingPct).maxTrialsPerRetro` (D-cq).
   */
  readonly user?: Pick<UserConfig, "lookback">;
  /**
   * The per-RETRO trial cap, when the caller computed it (engine core's daemon passes
   * `lookbackPaceFor(user, weeklyRemainingPct).maxTrialsPerRetro`); it wins over `user`'s.
   */
  readonly cap?: number;
}): {
  readonly launch: LaunchedReplay<T>[];
  readonly unreplayable: { readonly proposal: string; readonly reason: string }[];
  readonly skipped: AutomationSkippedDraft[];
} => {
  const unreplayable: { proposal: string; reason: string }[] = [];
  const skipped: AutomationSkippedDraft[] = [];
  const replayable: (PendingReplay<T> & { grader: ReplayGrader; groups: T[][] })[] = [];
  const oldestFirst = input.pending
    .map((replay, i) => {
      const at = Date.parse(replay.recordedAt);
      return { replay, i, at: Number.isNaN(at) ? Number.POSITIVE_INFINITY : at };
    })
    // an unreadable time sorts last; equal times (and two unreadable ones: NaN) keep caller order
    .sort((x, y) => x.at - y.at || x.i - y.i)
    .map((x) => x.replay);
  for (const replay of oldestFirst) {
    const grader = replayGraderFor(replay.role, replay.changesFiles);
    if (grader === null) {
      unreplayable.push({
        proposal: replay.proposal,
        reason: `no grader can score ${replay.role}: it changes no file and is not a verdict-graded role`,
      });
      continue;
    }
    if (replay.trials.length === 0) {
      unreplayable.push({
        proposal: replay.proposal,
        reason:
          grader === "verdict"
            ? "the baseline has no held-out task with a recorded outcome to replay"
            : "the baseline has no held-out task to replay",
      });
      continue;
    }
    const groups = groupsOf(replay.trials, input.graded(replay.proposal));
    const infra = input.infra?.(replay.proposal);
    const stuck = groups
      .flat()
      .map((t) => infra?.get(replayTrialKey(t)))
      .find((a) => a !== undefined && a.attempts >= REPLAY_MAX_INFRA_ATTEMPTS);
    if (stuck !== undefined) {
      const why = {
        plugin_locked: "the host did not load the arm's plugin (a managed-settings lock)",
        gate_infra: "the gates could not run (gate_infra)",
        no_outcome:
          "the replayed dispatch no longer has a recorded outcome to grade its verdict against",
      }[stuck.outcome];
      unreplayable.push({
        proposal: replay.proposal,
        reason: `a trial measured nothing ${String(REPLAY_MAX_INFRA_ATTEMPTS)} times: ${why}`,
      });
      if (stuck.outcome === "plugin_locked")
        skipped.push(
          replaySkippedEvent(
            "plugin_locked",
            `the replay of ${replay.proposal} stops: a managed-settings lock kept the installed vtc plugin on ${String(REPLAY_MAX_INFRA_ATTEMPTS)} attempts of one trial`,
          ),
        );
      continue;
    }
    replayable.push({ ...replay, grader, groups });
  }
  const launched = (
    replay: (typeof replayable)[number],
    trials: T[],
    remaining: number,
  ): LaunchedReplay<T> => ({
    proposal: replay.proposal,
    role: replay.role,
    ...(replay.mode === undefined ? {} : { mode: replay.mode }),
    host: replay.host,
    grader: replay.grader,
    trials,
    remaining,
  });
  // a replay with every trial graded needs no trial: it finishes whatever the limits say
  const finished = replayable.filter((r) => r.groups.length === 0);
  const running = replayable.filter((r) => r.groups.length > 0);
  if (running.length === 0)
    return { launch: finished.map((r) => launched(r, [], 0)), unreplayable, skipped };
  const limit = replayLimitReason(input);
  if (limit !== null) {
    const what =
      limit === "weekly_window"
        ? input.weeklyRemainingPct === null
          ? "the Lead host's weekly window is unknown"
          : `${String(Math.round(input.weeklyRemainingPct))}% of the Lead host's weekly window is left (Lookback needs ${String(LOOKBACK_LIMITS.minWeeklyRemainingPct)}%)`
        : "the Lookback budget is spent";
    return {
      launch: finished.map((r) => launched(r, [], 0)),
      unreplayable,
      skipped: [
        ...skipped,
        replaySkippedEvent(
          limit,
          `${plural(running.length, "replay")} wait for the next RETRO: ${what}`,
        ),
      ],
    };
  }
  const cap = Math.max(
    0,
    input.cap ?? lookbackPaceFor(input.user, input.weeklyRemainingPct).maxTrialsPerRetro,
  );
  let left = cap;
  let waiting = 0;
  let waitingReplays = 0;
  const launch: LaunchedReplay<T>[] = [];
  for (const replay of replayable) {
    const trials: T[] = [];
    let remaining = 0;
    for (const group of replay.groups) {
      if (remaining === 0 && group.length <= left) {
        trials.push(...group);
        left -= group.length;
      } else remaining += group.length;
    }
    if (remaining > 0) {
      waiting += remaining;
      waitingReplays += 1;
    }
    if (trials.length === 0 && remaining > 0) continue;
    launch.push(launched(replay, trials, remaining));
  }
  if (waiting > 0)
    skipped.push(
      replaySkippedEvent(
        "trial_cap",
        `${plural(waiting, "replay trial")} of ${plural(waitingReplays, "proposal")} wait for the next RETRO: one RETRO launches at most ${String(cap)}`,
      ),
    );
  return { launch, unreplayable, skipped };
};
