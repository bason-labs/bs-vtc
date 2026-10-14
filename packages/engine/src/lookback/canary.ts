/**
 * Canaries (spec §13 steps 5–6; AD-21 rule 7). A canary in `pins.yaml` splits a project's tasks
 * 50/50 by hash (`canaryArmFor`, sticky across fix rounds), and each dispatch records its arm
 * (`role.dispatched.canary_arm`). This module counts each arm's dispatches, escalations, cap hits
 * and tokens since the canary started, asks `canaryVerdict`, and rolls the canary back (the
 * engine's only write to pins.yaml) when it says so.
 */
import {
  canaryVerdict,
  CanaryStateSchema,
  isEventOfType,
  readEventData,
  type CanaryArmStats,
  type CanaryState,
  type VtcEvent,
} from "@vtc/shared";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { autoRollback, readPins, type PinTarget } from "./pins.js";

type Arm = "candidate" | "baseline";

interface Canary extends PinTarget {
  readonly candidate: string;
  readonly baseline: string;
  readonly started_at: string;
}

/** Each arm's numbers for one canary, from the events since it started. */
export const canaryArmStats = (
  events: readonly VtcEvent[],
  canary: Canary,
): { readonly candidate: CanaryArmStats; readonly baseline: CanaryArmStats } => {
  const start = Date.parse(canary.started_at);
  const stats: Record<
    Arm,
    { dispatches: number; escalations: number; capHits: number; tokens: number }
  > = {
    candidate: { dispatches: 0, escalations: 0, capHits: 0, tokens: 0 },
    baseline: { dispatches: 0, escalations: 0, capHits: 0, tokens: 0 },
  };
  const armOfAction = new Map<string, Arm>();
  const armOfTask = new Map<string, Arm>();
  for (const event of events) {
    if (Date.parse(event.ts) < start) continue;
    if (isEventOfType(event, "role.dispatched")) {
      const data = readEventData(event);
      if (
        data.canary_arm === undefined ||
        event.role !== canary.role ||
        data.mode !== canary.mode ||
        event.host !== canary.host
      ) {
        continue;
      }
      stats[data.canary_arm].dispatches += 1;
      armOfAction.set(`${event.run}:${data.action_id}`, data.canary_arm);
      if (event.task !== undefined) armOfTask.set(`${event.run}:${event.task}`, data.canary_arm);
    } else if (isEventOfType(event, "role.submitted")) {
      const arm = armOfAction.get(`${event.run}:${readEventData(event).action_id}`);
      if (arm !== undefined && event.tokens !== null && event.tokens !== undefined) {
        stats[arm].tokens += event.tokens.in + event.tokens.out;
      }
    } else if (isEventOfType(event, "escalation.opened") && event.task !== undefined) {
      const arm = armOfTask.get(`${event.run}:${event.task}`);
      if (arm !== undefined) stats[arm].escalations += 1;
    } else if (isEventOfType(event, "task.status_changed") && event.task !== undefined) {
      const change = readEventData(event);
      const arm = armOfTask.get(`${event.run}:${event.task}`);
      if (arm !== undefined && change.to === "parked" && change.park_reason === "cap")
        stats[arm].capHits += 1;
    }
  }
  return { candidate: stats.candidate, baseline: stats.baseline };
};

/**
 * Evaluates every canary of the project: one `lookback.canary_evaluated` draft each, and for a
 * `rollback` verdict the engine's `auto_rollback` plus `lookback.rolled_back`.
 * `humanFlags` names targets a human flagged as regressed (`role[-mode]@host`).
 */
export const evaluateCanaries = async (input: {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly events: readonly VtcEvent[];
  readonly now: Date;
  readonly humanFlags?: ReadonlySet<string>;
}): Promise<{ readonly states: CanaryState[]; readonly events: LookbackEventDraft[] }> => {
  const { pins } = await readPins(input.vtcHome);
  const canaries = pins.projects[input.repoKey]?.canaries ?? [];
  const states: CanaryState[] = [];
  const drafts: LookbackEventDraft[] = [];
  for (const canary of canaries) {
    const arms = canaryArmStats(input.events, canary);
    const key = `${canary.role}${canary.mode === undefined ? "" : `-${canary.mode}`}@${canary.host}`;
    const { verdict, reason } = canaryVerdict(
      arms.candidate,
      arms.baseline,
      input.humanFlags?.has(key) === true,
    );
    const arm = (s: CanaryArmStats) => ({
      dispatches: s.dispatches,
      escalations: s.escalations,
      cap_hits: s.capHits,
      tokens: s.tokens,
    });
    const state = CanaryStateSchema.parse({
      role: canary.role,
      ...(canary.mode === undefined ? {} : { mode: canary.mode }),
      host: canary.host,
      repo_key: input.repoKey,
      candidate: canary.candidate,
      baseline: canary.baseline,
      started_at: canary.started_at,
      arms: { candidate: arm(arms.candidate), baseline: arm(arms.baseline) },
      verdict,
      reason,
    });
    states.push(state);
    drafts.push(lookbackEvent("lookback.canary_evaluated", state));
    if (verdict === "rollback") {
      const rolled = await autoRollback({
        vtcHome: input.vtcHome,
        repoKey: input.repoKey,
        target: canary,
        reason,
        now: input.now,
      });
      if (rolled !== undefined) drafts.push(rolled);
    }
  }
  return { states, events: drafts };
};
