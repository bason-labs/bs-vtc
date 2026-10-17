import {
  QA_AUTHOR_MIN_TIER,
  type ModelTier,
  type RoleRunSummary,
  type TaskDetail,
  type TierHint,
  type TierHintReason,
  type TierReason,
} from "@vtc/shared";

/**
 * Difficulty-based model routing on the task view (H-9, D-cm, with D-cu's reviewer starts and D-cv's
 * Low-start escalation; spine §5 readings 218(6), 241, 242): the tier
 * each role run started on and why (`RoleRunSummary.tier`, `tier_reason`, `tier_clamped`), and
 * the Planner's reason-coded tier hint for the task (`Task.tier_hint`). A run logged before 5.4.0
 * has no tier, and nothing is shown for it.
 */
export const TIER_LABELS: Readonly<Record<ModelTier, string>> = {
  low: "Low",
  mid: "Mid",
  top: "Top",
};

export const TIER_REASON_LABELS: Readonly<Record<TierReason, string>> = {
  role: "the role's own tier (role.yaml)",
  rule: "the routing table, from the task's size and risk (security verify and the cross-family reviewer: one tier up on a high-risk task)",
  planner_hint: "the Planner's tier hint for this task",
  escalation: "one tier up: after every failed round from a Low start, after every 2 otherwise",
  budget_drop: "one tier down: reviewers reached 70% of the budget or their share",
};

export const TIER_HINT_REASON_LABELS: Readonly<Record<TierHintReason, string>> = {
  cross_cutting: "the change crosses modules",
  novel_logic: "it carries new logic",
  concurrency: "it involves concurrency",
  subtle_invariants: "it has subtle invariants",
  large_context: "it needs a large context",
  unfamiliar_stack: "it uses a stack the repo rarely uses",
  mechanical: "the change is mechanical",
  boilerplate: "it is boilerplate",
  docs_or_config: "it is docs or config only",
  well_specified: "it is so fully specified that a cheaper model suffices",
};

/**
 * `tier_clamped` (contracts 5.4.0): the project's `routing.min_tier` / `max_tier` or QA author's
 * floor ({@link QA_AUTHOR_MIN_TIER}, applied last and winning over `max_tier`; reading 218(4))
 * moved the tier. The log does not say which, so a QA author run held on the floor names both.
 */
export const CLAMPED_TEXT = "clamped by project routing (min_tier / max_tier)";
export const QA_FLOOR_CLAMPED_TEXT = `held at QA author's ${TIER_LABELS[QA_AUTHOR_MIN_TIER]} floor (or by project routing)`;

/** Why a clamped run's tier moved: QA author's floor when the run sits on it, else the project. */
const clampedText = (run: RoleRunSummary): string =>
  run.role === "qa" && run.mode === "author" && run.tier === QA_AUTHOR_MIN_TIER
    ? QA_FLOOR_CLAMPED_TEXT
    : CLAMPED_TEXT;

export interface TierView {
  /** `Low`, `Mid` or `Top`. */
  readonly tier: string;
  readonly reason: string;
  /**
   * {@link QA_FLOOR_CLAMPED_TEXT} or {@link CLAMPED_TEXT} when `tier_clamped` says the tier was
   * moved, else `null`.
   */
  readonly clamped: string | null;
}

/** The tier a run started on and why, or `null` for a run logged without one (before 5.4.0). */
export const roleRunTier = (run: RoleRunSummary): TierView | null =>
  run.tier === undefined || run.tier_reason === undefined
    ? null
    : {
        tier: TIER_LABELS[run.tier],
        reason: TIER_REASON_LABELS[run.tier_reason],
        clamped: run.tier_clamped === true ? clampedText(run) : null,
      };

/** `Started on Mid: the routing table, …` — one line for the run lists. */
export const tierSentence = (view: TierView): string => `Started on ${view.tier}: ${view.reason}`;

export interface TierHintView {
  readonly tier: string;
  /** The reason code as the Planner wrote it (`TierHintReason`). */
  readonly code: TierHintReason;
  readonly reason: string;
  /** The Planner's one sentence, or `null`. */
  readonly detail: string | null;
}

export const tierHintView = (hint: TierHint | undefined): TierHintView | null =>
  hint === undefined
    ? null
    : {
        tier: TIER_LABELS[hint.tier],
        code: hint.reason,
        reason: TIER_HINT_REASON_LABELS[hint.reason],
        detail: hint.detail ?? null,
      };

export interface RoutedRun {
  readonly action: string;
  /** The role id, with its mode: `qa (author)`. */
  readonly role: string;
  readonly host: string;
  readonly model: string;
  readonly at: string;
  readonly tier: TierView;
}

export interface TaskRouting {
  readonly hint: TierHintView | null;
  /** Runs with a recorded tier, in dispatch order. */
  readonly runs: readonly RoutedRun[];
}

/** The task's routing: its Planner hint and every role run with a tier, oldest first. */
export const taskRouting = (detail: TaskDetail): TaskRouting => ({
  hint: tierHintView(detail.task.tier_hint),
  runs: detail.role_runs
    .flatMap((run): RoutedRun[] => {
      const tier = roleRunTier(run);
      return tier === null
        ? []
        : [
            {
              action: run.action_id,
              role: run.mode === undefined ? run.role : `${run.role} (${run.mode})`,
              host: run.host,
              model: run.model,
              at: run.dispatched_at,
              tier,
            },
          ];
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
});
