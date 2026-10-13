/** Feature state (§6.7a Final Review on the integrated branch). */
import { z } from "zod";
import { FeatureIdSchema, TaskIdSchema } from "./primitives.js";
import { ParkReasonSchema } from "./task.js";

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

export const PullRequestRefSchema = z.strictObject({
  url: z.url(),
  /** Level 2 keeps the PR a draft until Final Review passes (§6.7). */
  draft: z.boolean(),
});
export type PullRequestRef = z.infer<typeof PullRequestRefSchema>;

export const FeatureSchema = z
  .strictObject({
    id: FeatureIdSchema,
    title: z.string().min(1).max(200),
    status: FeatureStatusSchema,
    park_reason: ParkReasonSchema.optional(),
    tasks: z.array(TaskIdSchema).min(1),
    integration_branch: z.string().min(1).max(255),
    round: z.int().min(0).max(FINAL_REVIEW_CAP).default(0),
    budget_usd: z.number().positive(),
    final_review_budget_usd: z.number().nonnegative(),
    spent_usd: z.number().nonnegative().default(0),
    pr: PullRequestRefSchema.optional(),
  })
  .superRefine((feature, ctx) => {
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
