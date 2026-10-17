/**
 * Autopilot (spine §5 reading 271): a run whose human asked to review only its PR. The engine
 * answers the questions it may decide with their recommended option and approves G1 and G2 (the
 * engine does both in `engine.ts`, `runAutopilot`); this module says which questions those are,
 * and lists every decision it took for the PR description, so the human reviews them there.
 *
 * It never decides alone: a budget raise, a risk rule (security, dependencies, licences, paths),
 * a fix loop that is stuck or at its cap, a gate's infrastructure or login, a change request,
 * an option that waives, drops, or changes a frozen artifact, and a question it already answered
 * {@link AUTOPILOT_MAX_REPEATS} times for the same role and scope (the answer did not help).
 */
import type { Escalation, EscalationEffect, EscalationReason } from "@vtc/shared";
import type { RunState } from "./state.js";

/** The questions autopilot may answer: a role's question, block or spec conflict. */
const AUTOPILOT_REASONS: ReadonlySet<EscalationReason> = new Set([
  "spec_question",
  "blocked",
  "spec_conflict",
]);

/** What autopilot's choice may do: send the role on with an answer, or replan or retry it. */
const AUTOPILOT_EFFECTS: ReadonlySet<EscalationEffect> = new Set([
  "clarify",
  "hint",
  "retry",
  "replan",
]);

/** Autopilot answers one role's question in one scope at most this often; then the human does. */
export const AUTOPILOT_MAX_REPEATS = 2;

/** Autopilot decides at most this many questions in a run; then the human decides the rest. */
export const AUTOPILOT_MAX_ANSWERS = 12;

const scopeOf = (e: Escalation): string =>
  `${e.raised_by ?? "engine"}:${e.task ?? e.feature ?? e.phase ?? "run"}`;

/** The engine's own answers in this run (`escalation.answered` with `autopilot`). */
const autopilotAnswered = (state: RunState): Escalation[] =>
  state.events.flatMap((event) => {
    if (event.type !== "escalation.answered") return [];
    const data = event.data as { escalation?: string; autopilot?: boolean };
    if (data.autopilot !== true || data.escalation === undefined) return [];
    const escalation = state.escalations.get(data.escalation);
    return escalation === undefined ? [] : [escalation];
  });

/**
 * The option autopilot picks for an open escalation, or why it leaves it for the human. Only a
 * question a role raised (or a spec question) with a recommended option whose effect only sends
 * the work on is decided; everything else stays the human's.
 */
export const autopilotChoice = (
  state: RunState,
  escalation: Escalation,
): { readonly option: string } | { readonly hold: string } => {
  if (!AUTOPILOT_REASONS.has(escalation.reason))
    return { hold: `a ${escalation.reason.replace(/_/g, " ")} is the human's decision` };
  if (escalation.reason !== "spec_question" && escalation.raised_by === undefined)
    return { hold: "the engine raised it, so a retry would not change the answer" };
  const option = escalation.options.find((o) => o.id === escalation.recommended);
  if (option === undefined) return { hold: "it has no recommended option" };
  if (!AUTOPILOT_EFFECTS.has(option.effect))
    return { hold: `its recommended option would ${option.effect.replace(/_/g, " ")}` };
  const answered = autopilotAnswered(state);
  if (answered.length >= AUTOPILOT_MAX_ANSWERS)
    return {
      hold: `autopilot already decided ${String(AUTOPILOT_MAX_ANSWERS)} questions in this run`,
    };
  const scope = scopeOf(escalation);
  if (answered.filter((e) => scopeOf(e) === scope).length >= AUTOPILOT_MAX_REPEATS)
    return { hold: "autopilot answered this role here before, and it asked again" };
  return { option: option.id };
};

export interface AutopilotDecision {
  readonly kind: "answer" | "gate";
  /** The escalation id, or the gates approved (`G1`, `G2`, `G1+G2`). */
  readonly ref: string;
  /** The question and the option chosen, or what the gate froze. */
  readonly summary: string;
}

/** Every decision the engine took for the human in this run, in order. */
export const autopilotDecisions = (state: RunState): AutopilotDecision[] =>
  state.events.flatMap((event): AutopilotDecision[] => {
    if (event.type === "escalation.answered") {
      const data = event.data as {
        escalation: string;
        autopilot?: boolean;
        answer: { option: string };
      };
      if (data.autopilot !== true) return [];
      const escalation = state.escalations.get(data.escalation);
      const label =
        escalation?.options.find((o) => o.id === data.answer.option)?.label ?? data.answer.option;
      return [
        {
          kind: "answer",
          ref: data.escalation,
          summary: `${escalation?.question ?? "question"} → ${label}`,
        },
      ];
    }
    if (event.type === "gate.approved") {
      const data = event.data as {
        gates: string[];
        autopilot?: boolean;
        frozen: { path: string }[];
      };
      if (data.autopilot !== true) return [];
      return [
        {
          kind: "gate",
          ref: data.gates.join("+"),
          summary: `approved ${data.frozen.map((f) => `\`${f.path}\``).join(", ")}`,
        },
      ];
    }
    return [];
  });

/**
 * The PR description's autopilot section: what the engine decided for the human, so the PR is
 * where they review the spec, the design and every answer. Empty when the run is not on autopilot.
 */
export const autopilotPrSection = (state: RunState): string => {
  if (!state.autopilot) return "";
  const decisions = autopilotDecisions(state);
  const line = (text: string): string => text.replace(/\s+/g, " ").trim().slice(0, 400);
  return [
    "## Autopilot",
    "",
    "This run ran on autopilot: VTC took these decisions for you. Review them with the code; to change one, request changes on this PR.",
    "",
    ...(decisions.length === 0
      ? ["- No question or gate needed a decision."]
      : decisions.map((d) => `- **${d.ref}** ${line(d.summary)}`)),
    "",
  ].join("\n");
};
