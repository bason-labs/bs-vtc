/**
 * Which replay trials a RETRO launches (D-cg, D-ch; spine §5 readings 201 and 202; AD-21 rules 6
 * and 8). Pure: engine core's runner hands it every pending replay with its full trial plan
 * (`planReplayTrials`) and the trials the ledger already graded (`readReplayTrials`), and launches
 * what it returns.
 * - **Grader.** A replay runs only when a grader can score its role (`replayGraderFor`): `gates`
 *   for a role that changes files, on either host (on Claude Code each arm runs its own plugin),
 *   `verdict` for a role in `VERDICT_GRADED_ROLES`. Any other is left out with its reason.
 * - **Limits.** Replay trials are engine-launched headless runs bounded by the Lead host's weekly
 *   window, the Lookback budget and the per-RETRO trial cap (`LOOKBACK_LIMITS.maxTrialsPerRetro`).
 *   When a limit is hit, what is left waits for the next RETRO and the run logs
 *   `automation.skipped` with the limit's reason (`weekly_window`, `budget`, `trial_cap`).
 * - **Order.** Oldest replay first, each one's trials in plan order (interleaved arms), in whole
 *   groups (one task's trial number across its arms), so a pair is never split across RETROs. A
 *   replay whose trials are all graded comes back with none to run: it is ready to finish
 *   (`assembleReplay`).
 */
import {
  LOOKBACK_LIMITS,
  replayGraderFor,
  type AutomationSkipReason,
  type HostId,
  type ReplayGrader,
} from "@vtc/shared";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { replayTrialKey, type ReplayTrialId } from "./replay-ledger.js";

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

/** Pure: the replays this RETRO launches, the ones no grader can score, and the limits it hit. */
export const planRetroReplays = <T extends ReplayTrialId>(input: {
  readonly pending: readonly PendingReplay<T>[];
  /** The trial keys (`replayTrialKey`) the ledger already graded for a proposal. */
  readonly graded: (proposal: string) => ReadonlySet<string>;
  readonly weeklyRemainingPct: number | null;
  readonly budgetAvailable: boolean;
  /** Default `LOOKBACK_LIMITS.maxTrialsPerRetro`. */
  readonly cap?: number;
}): {
  readonly launch: LaunchedReplay<T>[];
  readonly unreplayable: { readonly proposal: string; readonly reason: string }[];
  readonly skipped: AutomationSkippedDraft[];
} => {
  const unreplayable: { proposal: string; reason: string }[] = [];
  const replayable: (PendingReplay<T> & { grader: ReplayGrader })[] = [];
  for (const replay of input.pending) {
    const grader = replayGraderFor(replay.role, replay.changesFiles);
    if (grader === null)
      unreplayable.push({
        proposal: replay.proposal,
        reason: `no grader can score ${replay.role}: it changes no file and is not a verdict-graded role`,
      });
    else replayable.push({ ...replay, grader });
  }
  if (replayable.length === 0) return { launch: [], unreplayable, skipped: [] };
  const limit = replayLimitReason(input);
  if (limit !== null) {
    const what =
      limit === "weekly_window"
        ? input.weeklyRemainingPct === null
          ? "the Lead host's weekly window is unknown"
          : `${String(Math.round(input.weeklyRemainingPct))}% of the Lead host's weekly window is left (Lookback needs ${String(LOOKBACK_LIMITS.minWeeklyRemainingPct)}%)`
        : "the Lookback budget is spent";
    return {
      launch: [],
      unreplayable,
      skipped: [
        replaySkippedEvent(
          limit,
          `${plural(replayable.length, "replay")} wait for the next RETRO: ${what}`,
        ),
      ],
    };
  }
  let left = input.cap ?? LOOKBACK_LIMITS.maxTrialsPerRetro;
  let waiting = 0;
  let waitingReplays = 0;
  const launch: LaunchedReplay<T>[] = [];
  for (const replay of replayable) {
    const groups = groupsOf(replay.trials, input.graded(replay.proposal));
    const trials: T[] = [];
    let remaining = 0;
    for (const group of groups) {
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
    launch.push({
      proposal: replay.proposal,
      role: replay.role,
      ...(replay.mode === undefined ? {} : { mode: replay.mode }),
      host: replay.host,
      grader: replay.grader,
      trials,
      remaining,
    });
  }
  const skipped =
    waiting === 0
      ? []
      : [
          replaySkippedEvent(
            "trial_cap",
            `${plural(waiting, "replay trial")} of ${plural(waitingReplays, "proposal")} wait for the next RETRO: one RETRO launches at most ${String(input.cap ?? LOOKBACK_LIMITS.maxTrialsPerRetro)}`,
          ),
        ];
  return { launch, unreplayable, skipped };
};
