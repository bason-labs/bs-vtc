/**
 * Escalation items (§6.5): one question, 2–4 options with one recommended, evidence, and the
 * tasks it blocks (the parked task plus its transitive dependents). Pure.
 */
import {
  EscalationSchema,
  runRequestPath,
  type Escalation,
  type EscalationOption,
  type Evidence,
  type ParkReason,
  type Phase,
  type RiskRuleReasonRule,
} from "@vtc/shared";

/** Waivers always expire (§6.5, §8.5); the default lifetime of one offered here. */
export const WAIVER_DAYS = 7;

export interface ParkEscalationInput {
  readonly id: string;
  readonly run: string;
  readonly task?: string;
  readonly feature?: string;
  readonly phase?: Phase;
  readonly reason: ParkReason;
  readonly riskRule?: RiskRuleReasonRule;
  readonly detail: string;
  readonly evidence: readonly Evidence[];
  readonly blocks: readonly string[];
  readonly now: Date;
  readonly raisedBy?: string;
}

const waiveOption = (now: Date, label: string): EscalationOption => ({
  id: "waive",
  label,
  effect: "waive",
  waiver_expires_at: new Date(now.getTime() + WAIVER_DAYS * 86_400_000).toISOString(),
});

const DROP: EscalationOption = { id: "drop", label: "Drop the task (and the tasks it blocks)", effect: "drop" };

const optionsFor = (
  reason: ParkReason,
  now: Date,
): { question: string; options: EscalationOption[]; recommended: string } => {
  switch (reason) {
    case "cap":
    case "stuck":
      return {
        question:
          reason === "cap"
            ? "The task reached its round cap. How should it proceed?"
            : "The fix loop stopped making progress. How should it proceed?",
        options: [
          { id: "hint", label: "Give the Engineer a hint and run one more round", effect: "hint" },
          waiveOption(now, `Accept the open findings with a ${String(WAIVER_DAYS)}-day waiver`),
          DROP,
        ],
        recommended: "hint",
      };
    case "risk_rule":
      return {
        question: "A risk rule fired on this task. Accept the change or send it back?",
        options: [
          { id: "hint", label: "Send it back to the Engineer with guidance", effect: "hint" },
          waiveOption(now, `Accept it with a ${String(WAIVER_DAYS)}-day waiver`),
          DROP,
        ],
        recommended: "hint",
      };
    case "budget":
      return {
        question: "The task spent its budget. Raise it or stop?",
        options: [
          { id: "raise-1-5x", label: "Raise the budget to 1.5×", effect: "raise_budget", budget_factor: 1.5 },
          { id: "raise-2x", label: "Raise the budget to 2× (the maximum)", effect: "raise_budget", budget_factor: 2 },
          DROP,
        ],
        recommended: "raise-1-5x",
      };
    case "gate_infra":
      return {
        question: "The gates could not run (infrastructure or a disallowed command). Retry once fixed?",
        options: [
          { id: "retry", label: "Retry the gates (after fixing the environment or running vtc calibrate)", effect: "retry" },
          DROP,
        ],
        recommended: "retry",
      };
    case "change_request":
      return {
        question: "Approve this change request?",
        options: [
          { id: "approve", label: "Approve the change and re-freeze the artifact", effect: "approve_change" },
          { id: "reject", label: "Reject the change", effect: "reject_change" },
        ],
        recommended: "approve",
      };
    case "spec_conflict":
    case "blocked":
    case "spec_question":
      return {
        question:
          reason === "spec_conflict"
            ? "The Engineer found a conflict in the spec. How should it be resolved?"
            : "The task is blocked on a question. How should it proceed?",
        options: [
          { id: "clarify", label: "Answer with a clarification and continue", effect: "clarify" },
          { id: "hint", label: "Give a hint and continue", effect: "hint" },
          DROP,
        ],
        recommended: "clarify",
      };
  }
};

/** An escalation for a park (§6.5) with the standard options of its reason. */
export const parkEscalation = (input: ParkEscalationInput): Escalation => {
  const { question, options, recommended } = optionsFor(input.reason, input.now);
  return EscalationSchema.parse({
    id: input.id,
    run: input.run,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.feature === undefined ? {} : { feature: input.feature }),
    ...(input.task === undefined && input.feature === undefined && input.phase !== undefined
      ? { phase: input.phase }
      : {}),
    reason: input.reason,
    ...(input.riskRule === undefined ? {} : { risk_rule: input.riskRule }),
    detail: input.detail.slice(0, 2000),
    question,
    options,
    recommended,
    // Without other evidence, cite the run's request (always projected, AD-7 rule 8).
    evidence:
      input.evidence.length > 0 ? input.evidence : [{ type: "file", ref: runRequestPath(input.run) }],
    blocks: [...input.blocks],
    ...(input.raisedBy === undefined ? {} : { raised_by: input.raisedBy }),
    created_at: input.now.toISOString(),
  });
};
