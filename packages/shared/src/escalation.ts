/** Escalation contract (§6.5 parking and escalation, §6.3 step 2 spec questions, §16). */
import { z } from "zod";
import {
  EscalationIdSchema,
  EvidenceSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  RoleIdSchema,
  RunIdSchema,
  SlugSchema,
  TaskIdSchema,
} from "./primitives.js";
import { ParkReasonSchema } from "./task.js";

/** Reason categories (§6.5) plus `spec_question` (§6.3) and `blocked` (Engineer exit). */
export const EscalationReasonSchema = ParkReasonSchema;
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

/**
 * What choosing an option does (§6.5 typical answers). `clarify` answers a spec question;
 * `approve_change` / `reject_change` decide a change request (§6.2).
 */
export const EscalationEffectSchema = z.enum([
  "waive",
  "hint",
  "replan",
  "raise_budget",
  "drop",
  "retry",
  "clarify",
  "approve_change",
  "reject_change",
]);
export type EscalationEffect = z.infer<typeof EscalationEffectSchema>;

/** Budget raises are human-only and capped at 2× (§6.5, §11). */
export const MAX_BUDGET_RAISE_FACTOR = 2;

export const EscalationOptionSchema = z
  .strictObject({
    id: SlugSchema,
    label: z.string().min(1).max(300),
    effect: EscalationEffectSchema,
    /** Required for `raise_budget`: the new budget as a multiple of the original (1 < f <= 2). */
    budget_factor: z.number().gt(1).max(MAX_BUDGET_RAISE_FACTOR).optional(),
    /** Required for `waive`: waivers always expire (§6.5, §8.5). */
    waiver_expires_at: IsoDateTimeSchema.optional(),
  })
  .superRefine((option, ctx) => {
    if (option.effect === "raise_budget" && option.budget_factor === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["budget_factor"],
        message: "raise_budget requires budget_factor",
      });
    }
    if (option.effect !== "raise_budget" && option.budget_factor !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["budget_factor"],
        message: "budget_factor is only allowed with raise_budget",
      });
    }
    if (option.effect === "waive" && option.waiver_expires_at === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["waiver_expires_at"],
        message: "waive requires waiver_expires_at",
      });
    }
  });
export type EscalationOption = z.infer<typeof EscalationOptionSchema>;

/** The human's answer, relayed by the Lead (§6.5). `who_should_have_caught` feeds Lookback (§13). */
export const EscalationAnswerSchema = z.strictObject({
  option: SlugSchema,
  text: z.string().max(4000).optional(),
  /** Role id that should have caught this, or `none`. Gold-standard attribution label (§13). */
  who_should_have_caught: RoleIdSchema,
});
export type EscalationAnswer = z.infer<typeof EscalationAnswerSchema>;

export const EscalationSchema = z
  .strictObject({
    id: EscalationIdSchema,
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    reason: EscalationReasonSchema,
    /** Free-text detail, e.g. which risk rule fired. */
    detail: z.string().max(2000).optional(),
    /** Exactly one question (§6.5). */
    question: z.string().min(1).max(1000),
    options: z.array(EscalationOptionSchema).min(2).max(4),
    recommended: SlugSchema,
    evidence: z.array(EvidenceSchema).min(1),
    /** Tasks blocked until this is answered (the parked task plus its transitive dependents). */
    blocks: z.array(TaskIdSchema).default([]),
    created_at: IsoDateTimeSchema,
    answer: EscalationAnswerSchema.optional(),
    answered_at: IsoDateTimeSchema.optional(),
  })
  .superRefine((esc, ctx) => {
    if (esc.task === undefined && esc.feature === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["task"],
        message: "escalation needs a task or a feature",
      });
    }
    const optionIds = esc.options.map((o) => o.id);
    if (new Set(optionIds).size !== optionIds.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
    }
    if (!optionIds.includes(esc.recommended)) {
      ctx.addIssue({
        code: "custom",
        path: ["recommended"],
        message: "recommended must be one of the option ids",
      });
    }
    if ((esc.answer === undefined) !== (esc.answered_at === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["answered_at"],
        message: "answer and answered_at must be set together",
      });
    }
    if (esc.answer !== undefined && !optionIds.includes(esc.answer.option)) {
      ctx.addIssue({
        code: "custom",
        path: ["answer", "option"],
        message: "answer.option must be one of the option ids",
      });
    }
  });
export type Escalation = z.infer<typeof EscalationSchema>;
