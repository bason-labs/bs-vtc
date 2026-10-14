/** Feature state (§6.7a Final Review on the integrated branch). */
import { z } from "zod";
import {
  FeatureIdSchema,
  GitShaSchema,
  RiskRuleReasonRuleSchema,
  TaskIdSchema,
} from "./primitives.js";
import { checkParkRiskRule, ParkReasonSchema } from "./task.js";

/** `building → integrating → final_review ⇄ fixing(n/3) → ready_to_ship → shipped`, side state `parked`. */
export const FeatureStatusSchema = z.enum([
  "building",
  "integrating",
  "final_review",
  "fixing",
  "ready_to_ship",
  "shipped",
  "parked",
]);
export type FeatureStatus = z.infer<typeof FeatureStatusSchema>;

/** Final Review has its own fixed cap of 3 rounds (§6.7a). */
export const FINAL_REVIEW_CAP = 3;
/** Default Final Review budget line: 15% of the feature's total budget (§6.7a). */
export const DEFAULT_FINAL_REVIEW_SHARE = 0.15;

/** Remote CI on the PR head (§6.7 Level-3 checklist item 7). `unknown` = no CI status reported. */
export const PullRequestCiSchema = z.enum(["pending", "green", "red", "unknown"]);
export type PullRequestCi = z.infer<typeof PullRequestCiSchema>;

/** A required status check on a commit, as `gh pr checks --required` reports its bucket. */
export const RequiredCheckStateSchema = z.enum([
  "success",
  "pending",
  "failure",
  "skipped",
  "cancelled",
  "unknown",
]);
export type RequiredCheckState = z.infer<typeof RequiredCheckStateSchema>;

export const RequiredCheckSchema = z.strictObject({
  name: z.string().min(1).max(200),
  state: RequiredCheckStateSchema,
});
export type RequiredCheck = z.infer<typeof RequiredCheckSchema>;

/**
 * Where the feature PR's auto-merge stands (`PullRequestRef.auto_merge`):
 * `awaiting_checks` (required checks on the gated SHA still pending), `awaiting_review` (the base
 * requires an approving review VTC never gives itself), `enabled` (`gh pr merge --auto` accepted),
 * `queued` (in the base's merge queue), `merged`, `disabled` (GitHub or `vtc pause` turned it
 * off: the head moved, the base changed, a conflict).
 */
export const AutoMergeStateSchema = z.enum([
  "not_requested",
  "awaiting_checks",
  "awaiting_review",
  "enabled",
  "queued",
  "merged",
  "disabled",
]);
export type AutoMergeState = z.infer<typeof AutoMergeStateSchema>;

/**
 * The feature's PR as the engine last observed it (`feature.pr_updated`, through the user's own
 * `gh` auth). `state: merged` with `merge_commit` is the Level-3 merge into main (§6.7): it has no
 * task, so it is recorded here and not as `merge.completed`.
 */
export const PullRequestRefSchema = z
  .strictObject({
    url: z.url(),
    /** Level 2 keeps the PR a draft until Final Review passes (§6.7). */
    draft: z.boolean(),
    state: z.enum(["open", "merged", "closed"]),
    /** The PR's head commit (the pushed integration branch). */
    head_sha: GitShaSchema,
    ci: PullRequestCiSchema,
    /** The commit on main, once merged. */
    merge_commit: GitShaSchema.optional(),
    /** The PR number (`gh pr view --json number`), for `gh pr merge <n>`. New in 4.5.0. */
    number: z.int().positive().optional(),
    /** Level 3: where the PR's auto-merge stands (AD-23). New in 4.5.0. */
    auto_merge: AutoMergeStateSchema.optional(),
    /** The base's required checks on `head_sha`; `ci` stays the rollup. New in 4.5.0. */
    required_checks: z.array(RequiredCheckSchema).optional(),
    /** GitHub's `mergeStateStatus` as `gh` reports it (e.g. `BLOCKED`, `CLEAN`). New in 4.5.0. */
    merge_state_status: z
      .string()
      .regex(/^[A-Z_]{1,32}$/)
      .optional(),
  })
  .refine((pr) => (pr.state === "merged") === (pr.merge_commit !== undefined), {
    message: "merge_commit is required for, and only allowed with, state merged",
    path: ["merge_commit"],
  });
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

/** The integration branch of a feature: `vtc/F-n` (§6.7). */
export const integrationBranchFor = (feature: string): string =>
  `vtc/${FeatureIdSchema.parse(feature)}`;

/**
 * One feature per run (§6.7a): the engine creates it at PLAN, right after the Planner's tasks
 * (`feature.created` lists them; each task already names it), with id = the next free `F-n` in
 * the repo, `title` = the first non-empty line of the run's request (`run.started.request`,
 * trimmed, cut to 200 characters), `integration_branch` = `vtc/F-n`,
 * `budget_usd` = the sum of its tasks' budgets and `final_review_budget_usd` =
 * `budgets.final_review_share` × `budget_usd`. Tasks the engine adds later (integration fixes)
 * join through `feature.task_added`.
 */
export const FeatureSchema = z
  .strictObject({
    id: FeatureIdSchema,
    title: z.string().min(1).max(200),
    status: FeatureStatusSchema,
    park_reason: ParkReasonSchema.optional(),
    /** The §7.6 rule 1–9 that parked the feature; only with `park_reason: risk_rule`. */
    risk_rule: RiskRuleReasonRuleSchema.optional(),
    tasks: z.array(TaskIdSchema).min(1),
    integration_branch: z
      .string()
      .regex(/^vtc\/F-[1-9]\d*$/, "expected integration branch vtc/F-n"),
    /** Final Review fix rounds (§6.7a), capped at {@link FINAL_REVIEW_CAP}. */
    round: z.int().min(0).max(FINAL_REVIEW_CAP).default(0),
    budget_usd: z.number().positive(),
    final_review_budget_usd: z.number().nonnegative(),
    spent_usd: z.number().nonnegative().default(0),
    pr: PullRequestRefSchema.optional(),
  })
  .superRefine((feature, ctx) => {
    if (feature.integration_branch !== `vtc/${feature.id}`) {
      ctx.addIssue({
        code: "custom",
        path: ["integration_branch"],
        message: `integration_branch must be vtc/${feature.id}`,
      });
    }
    checkParkRiskRule(feature, ctx);
    if (feature.status === "parked" && feature.park_reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["park_reason"],
        message: "parked requires park_reason",
      });
    }
    if (feature.status !== "parked" && feature.park_reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["park_reason"],
        message: "park_reason is only allowed when status is parked",
      });
    }
    if (feature.final_review_budget_usd > feature.budget_usd) {
      ctx.addIssue({
        code: "custom",
        path: ["final_review_budget_usd"],
        message: "final review budget cannot exceed the feature budget",
      });
    }
    if (new Set(feature.tasks).size !== feature.tasks.length) {
      ctx.addIssue({ code: "custom", path: ["tasks"], message: "tasks must be unique" });
    }
  });
export type Feature = z.infer<typeof FeatureSchema>;
