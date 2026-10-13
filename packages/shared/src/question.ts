/**
 * A question for the human, with options (§6.5, §6.3 step 2). Roles raise questions inside a
 * RoleResult; the engine turns each one into an Escalation without losing anything
 * (`escalationFromQuestion`). Lives apart from escalation.ts so role-result.ts can use it
 * without an import cycle.
 */
import { z } from "zod";
import { EvidenceSchema, IsoDateTimeSchema, SlugSchema } from "./primitives.js";

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

/** Option list rules shared by questions and escalations: 2–4 options, unique ids, one recommended. */
export const checkEscalationOptions = (
  value: { options: readonly { id: string }[]; recommended: string },
  ctx: z.RefinementCtx,
): void => {
  const ids = value.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) {
    ctx.addIssue({ code: "custom", path: ["options"], message: "option ids must be unique" });
  }
  if (!ids.includes(value.recommended)) {
    ctx.addIssue({
      code: "custom",
      path: ["recommended"],
      message: "recommended must be one of the option ids",
    });
  }
};
/**
 * One question with 2–4 options and a recommendation (§6.5). QA spec questions offer 2–3
 * (§6.3 step 2); the prompt asks for that, the contract allows the escalation range.
 */
export const QuestionSchema = z
  .strictObject({
    question: z.string().min(1).max(1000),
    options: z.array(EscalationOptionSchema).min(2).max(4),
    recommended: SlugSchema,
    /** Every question cites what prompted it (principle 3), e.g. `spec_ref` REQ-3.AC-2. */
    evidence: z.array(EvidenceSchema).min(1),
  })
  .superRefine(checkEscalationOptions);
export type Question = z.infer<typeof QuestionSchema>;
export type QuestionInput = z.input<typeof QuestionSchema>;
