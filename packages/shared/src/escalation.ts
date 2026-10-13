/** Escalation contract (§6.5 parking and escalation, §6.3 step 2 spec questions, §16). */
import { z } from "zod";
import {
  EscalationIdSchema,
  EvidenceSchema,
  FeatureIdSchema,
  IsoDateTimeSchema,
  RiskRuleReasonRuleSchema,
  RoleIdSchema,
  RunIdSchema,
  SlugSchema,
  TaskIdSchema,
  type EscalationId,
  type FeatureId,
  type RiskRuleId,
  type RiskRuleReasonRule,
  type RunId,
  type TaskId,
} from "./primitives.js";
import { checkEscalationOptions, EscalationOptionSchema, type Question } from "./question.js";
import { PhaseSchema, type Phase } from "./run.js";
import { ParkReasonSchema, type ParkReason } from "./task.js";

/** Reason categories (§6.5) plus `spec_question` (§6.3) and `blocked` (role exit). */
export const EscalationReasonSchema = ParkReasonSchema;
export type EscalationReason = z.infer<typeof EscalationReasonSchema>;

/** The human's answer, relayed by the Lead (§6.5). `who_should_have_caught` feeds Lookback (§13). */
export const EscalationAnswerSchema = z.strictObject({
  option: SlugSchema,
  text: z.string().max(4000).optional(),
  /** Role id that should have caught this, or `none`. Gold-standard attribution label (§13). */
  who_should_have_caught: RoleIdSchema,
});
export type EscalationAnswer = z.infer<typeof EscalationAnswerSchema>;

/**
 * Scope rules: an escalation is about a task, a feature (optionally with its task), or, before
 * tasks exist (SPECIFY, DESIGN, calibration, change requests against the spec), a run `phase`.
 * `phase` is exclusive with `task` and `feature`.
 */
export const EscalationSchema = z
  .strictObject({
    id: EscalationIdSchema,
    run: RunIdSchema,
    task: TaskIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    /** Run-scoped escalations raised before PLAN (no task or feature exists yet). */
    phase: PhaseSchema.optional(),
    reason: EscalationReasonSchema,
    /**
     * Which §7.6 rule 1–9 fired; required when (and only when) reason is `risk_rule`. Rules
     * 10–13 use their dedicated reason (`RISK_RULE_REASON_RULES`, `riskRuleForPark`).
     */
    risk_rule: RiskRuleReasonRuleSchema.optional(),
    /** Free-text detail. */
    detail: z.string().max(2000).optional(),
    /** Exactly one question (§6.5). */
    question: z.string().min(1).max(1000),
    options: z.array(EscalationOptionSchema).min(2).max(4),
    recommended: SlugSchema,
    evidence: z.array(EvidenceSchema).min(1),
    /** Tasks blocked until this is answered (the parked task plus its transitive dependents). */
    blocks: z.array(TaskIdSchema).default([]),
    /** Role that raised the question, if any (e.g. `qa` for a spec_question). */
    raised_by: RoleIdSchema.optional(),
    created_at: IsoDateTimeSchema,
    answer: EscalationAnswerSchema.optional(),
    answered_at: IsoDateTimeSchema.optional(),
  })
  .superRefine((esc, ctx) => {
    if (esc.task === undefined && esc.feature === undefined && esc.phase === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["task"],
        message: "escalation needs a task, a feature or a run phase",
      });
    }
    if (esc.phase !== undefined && (esc.task !== undefined || esc.feature !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["phase"],
        message: "phase is only for run-scoped escalations without a task or feature",
      });
    }
    if ((esc.reason === "risk_rule") !== (esc.risk_rule !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["risk_rule"],
        message: "risk_rule is required for, and only allowed with, reason risk_rule",
      });
    }
    checkEscalationOptions(esc, ctx);
    if ((esc.answer === undefined) !== (esc.answered_at === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["answered_at"],
        message: "answer and answered_at must be set together",
      });
    }
    if (esc.answer !== undefined && !esc.options.some((o) => o.id === esc.answer?.option)) {
      ctx.addIssue({
        code: "custom",
        path: ["answer", "option"],
        message: "answer.option must be one of the option ids",
      });
    }
  });
export type Escalation = z.infer<typeof EscalationSchema>;
export type EscalationInput = z.input<typeof EscalationSchema>;

export interface EscalationContext {
  readonly id: EscalationId;
  readonly run: RunId;
  readonly reason: EscalationReason;
  readonly created_at: string;
  readonly task?: TaskId;
  readonly feature?: FeatureId;
  readonly phase?: Phase;
  readonly raised_by?: string;
  readonly blocks?: readonly TaskId[];
}

/**
 * Pure and lossless: a role's {@link Question} becomes an open Escalation. The engine adds only
 * the context (ids, scope, reason); question, options, recommendation and evidence are copied.
 */
export const escalationFromQuestion = (
  question: Question,
  context: EscalationContext,
): Escalation =>
  EscalationSchema.parse({
    ...context,
    blocks: [...(context.blocks ?? [])],
    question: question.question,
    options: question.options,
    recommended: question.recommended,
    evidence: question.evidence,
  });

const DEDICATED_REASON_RULE: Readonly<Partial<Record<ParkReason, RiskRuleId>>> = {
  cap: "stuck_or_cap",
  stuck: "stuck_or_cap",
  spec_conflict: "unresolved_spec_conflict",
  change_request: "unresolved_spec_conflict",
  gate_infra: "gate_infra_or_sandbox",
  budget: "budget_exhausted",
};

/**
 * The §7.6 risk rule a park or escalation stands for, or `null` when none fired (`spec_question`,
 * `blocked`). Pure. The Level-3 checklist item "no risk rule fired" (§6.7), Lookback attribution
 * and dashboard filters all use it, so the two encodings can never diverge.
 */
export const riskRuleForPark = (
  reason: ParkReason,
  riskRule?: RiskRuleReasonRule,
): RiskRuleId | null => {
  if (reason === "risk_rule") {
    if (riskRule === undefined) throw new TypeError("reason risk_rule needs the rule id");
    return riskRule;
  }
  return DEDICATED_REASON_RULE[reason] ?? null;
};
