import type { Escalation, EscalationOption } from "@vtc/shared";
import { parkText, PHASE_LABELS } from "./states";

/**
 * Escalations (§6.5), read-only: the human answers in the Lead chat, never here (D7, AD-5).
 */
export interface EscalationModel {
  readonly id: string;
  readonly scope: string;
  readonly reason: string;
  readonly question: string;
  readonly detail: string | null;
  readonly options: readonly { id: string; label: string; effect: string; recommended: boolean }[];
  readonly evidence: readonly string[];
  readonly blocks: readonly string[];
  readonly raisedBy: string | null;
  readonly createdAt: string;
  readonly answer: { option: string; text: string | null; caughtBy: string; at: string } | null;
}

const effectText = (option: EscalationOption): string => {
  if (option.effect === "raise_budget" && option.budget_factor !== undefined) {
    return `raise budget ×${String(option.budget_factor)}`;
  }
  return option.effect.replace(/_/g, " ");
};

const scopeText = (e: Escalation): string => {
  if (e.phase !== undefined) return `Run phase ${PHASE_LABELS[e.phase]}`;
  return [
    e.task === undefined ? null : `Task ${e.task}`,
    e.feature === undefined ? null : `Feature ${e.feature}`,
  ]
    .filter((s) => s !== null)
    .join(" · ");
};

export const escalationModel = (e: Escalation): EscalationModel => ({
  id: e.id,
  scope: scopeText(e),
  reason: parkText(e.reason, e.risk_rule),
  question: e.question,
  detail: e.detail ?? null,
  options: e.options.map((o) => ({
    id: o.id,
    label: o.label,
    effect: effectText(o),
    recommended: o.id === e.recommended,
  })),
  evidence: e.evidence.map((ev) => `${ev.type}: ${ev.ref}`),
  blocks: e.blocks,
  raisedBy: e.raised_by ?? null,
  createdAt: e.created_at,
  answer:
    e.answer === undefined || e.answered_at === undefined
      ? null
      : {
          option: e.options.find((o) => o.id === e.answer?.option)?.label ?? e.answer.option,
          text: e.answer.text ?? null,
          caughtBy: e.answer.who_should_have_caught,
          at: e.answered_at,
        },
});

/** Open escalations first (oldest first: the order the Lead batches them), then answered (newest first). */
export const sortEscalations = (list: readonly Escalation[]): Escalation[] => {
  const open = list
    .filter((e) => e.answer === undefined)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const answered = list
    .filter((e) => e.answer !== undefined)
    .sort((a, b) => (b.answered_at ?? "").localeCompare(a.answered_at ?? ""));
  return [...open, ...answered];
};
