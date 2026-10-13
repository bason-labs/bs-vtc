/**
 * Loop controller (§6.3 step 9, §7.6 rules 8–10; AD-8 rules 1 and 13). Pure: after a failed
 * verification round it decides between another fix round and parking (`stuck` or `cap`); it
 * picks the Engineer's model tier (one tier up, fresh session, after 2 failed rounds).
 */
import {
  openHighRuleFires,
  type Finding,
  type ModelTier,
  type RiskRuleReasonRule,
} from "@vtc/shared";
import { lastSeen, weightedSeverityOfRound } from "./triage.js";

export interface RoundSignals {
  /** The round that just failed (1-based). */
  readonly round: number;
  readonly cap: number;
  /** Every finding of the task so far, after merging this round. */
  readonly findings: readonly Finding[];
  /** A resolved fingerprint came back this round. */
  readonly reappeared: boolean;
  /** The Engineer submitted the same tree as in the previous round. */
  readonly identicalTree: boolean;
}

export type LoopDecision =
  | { readonly kind: "fix"; readonly round: number }
  | { readonly kind: "park"; readonly reason: "cap" | "stuck"; readonly detail: string };

const open = (f: Finding): boolean => f.status === "open";

/** Why a task is stuck, or `null` (§6.3 step 9: any of four signals). */
export const stuckReason = (signals: RoundSignals): string | null => {
  const survivor = signals.findings.find((f) => open(f) && lastSeen(f) - f.round_first_seen >= 2);
  if (survivor !== undefined) {
    return `finding ${survivor.fingerprint.slice(0, 12)} survived 2 rounds (${survivor.title})`;
  }
  if (signals.reappeared) return "a resolved finding reappeared";
  if (signals.identicalTree) return "the Engineer submitted an identical diff";
  if (signals.round >= 2) {
    const now = weightedSeverityOfRound(signals.findings, signals.round);
    const before = weightedSeverityOfRound(signals.findings, signals.round - 1);
    if (before > 0 && now >= before) {
      return `weighted severity did not drop (${String(before)} → ${String(now)})`;
    }
  }
  return null;
};

/** Another fix round, or park: stuck first (it says more), then the round cap. */
export const decideAfterFailedRound = (signals: RoundSignals): LoopDecision => {
  const stuck = stuckReason(signals);
  if (stuck !== null) return { kind: "park", reason: "stuck", detail: stuck };
  if (signals.round + 1 > signals.cap) {
    return {
      kind: "park",
      reason: "cap",
      detail: `round cap ${String(signals.cap)} reached`,
    };
  }
  return { kind: "fix", round: signals.round + 1 };
};

/**
 * §7.6 rules 8 and 9 on the task's findings after a round: a repeated test-integrity violation
 * (in two different rounds), or a high/critical finding still open after one fix round.
 */
export const findingRiskRule = (
  findings: readonly Finding[],
  round: number,
): { readonly rule: RiskRuleReasonRule; readonly finding: Finding } | null => {
  const integrity = findings.filter(
    (f) => f.category === "test_integrity" && f.status !== "discarded",
  );
  const rounds = new Set(
    integrity.flatMap((f) =>
      Array.from(
        { length: lastSeen(f) - f.round_first_seen + 1 },
        (_v, i) => f.round_first_seen + i,
      ),
    ),
  );
  const openIntegrity = integrity.find((f) => f.status === "open");
  if (rounds.size >= 2 && openIntegrity !== undefined) {
    return { rule: "repeated_test_integrity", finding: openIntegrity };
  }
  const high = findings.find((f) => openHighRuleFires(f, round));
  return high === undefined ? null : { rule: "open_high_finding", finding: high };
};

const TIER_UP: Readonly<Record<ModelTier, ModelTier>> = { low: "mid", mid: "top", top: "top" };
const TIER_DOWN: Readonly<Record<ModelTier, ModelTier>> = { top: "mid", mid: "low", low: "low" };

export const tierUp = (tier: ModelTier): ModelTier => TIER_UP[tier];
export const tierDown = (tier: ModelTier): ModelTier => TIER_DOWN[tier];

/** Failed rounds after which the Engineer escalates one model tier (§6.3 step 9). */
export const ESCALATE_AFTER_FAILED_ROUNDS = 2;

/**
 * The Engineer's tier and session for round `round`: from round 3 on (after 2 failed rounds) one
 * tier up; the escalation round itself starts a fresh session.
 */
export const engineerDispatch = (
  baseTier: ModelTier,
  round: number,
): { readonly tier: ModelTier; readonly freshSession: boolean } => {
  const escalated = round > ESCALATE_AFTER_FAILED_ROUNDS;
  return {
    tier: escalated ? tierUp(baseTier) : baseTier,
    freshSession: round === ESCALATE_AFTER_FAILED_ROUNDS + 1,
  };
};
