import type { ModelFallback, VtcEvent } from "@vtc/shared";
import { eventsOfType } from "./events";

/**
 * What a role run cost and which model it ran on, from the run's event log by action id.
 * A run whose model has no known price keeps `cost_usd` null, shown as unknown, and counts its
 * tokens at the host's price ceiling toward the budget (`role.submitted.budget_usd`, H-12; spine
 * §5 reading 236). A dispatch whose model the host refused runs once more on the host default
 * (`role.dispatched.model_fallback`, D-cx; reading 244).
 */
export interface RoleRunNote {
  /** `$1.20`, `Cost unknown · counted as $0.84 toward the budget`, or `null` before it ends. */
  readonly cost: string | null;
  readonly fallback: string | null;
  /** The host's one-line refusal, or `null`. */
  readonly fallbackDetail: string | null;
}

const usd = (value: number): string =>
  value > 0 && value < 0.005 ? "<$0.01" : `$${value.toFixed(2)}`;

/**
 * The cost of a submitted run (`cost_usd` on its `role.submitted`), and what it counts toward the
 * budget when that differs (`budget_usd`); `null` when neither is known.
 */
export const roleCostText = (
  cost: number | null | undefined,
  budget: number | undefined,
): string | null => {
  const counted = budget === undefined ? null : `counted as ${usd(budget)} toward the budget`;
  if (cost === undefined || cost === null) {
    if (cost === undefined && counted === null) return null;
    return counted === null ? "Cost unknown" : `Cost unknown · ${counted}`;
  }
  return counted === null || budget === cost ? usd(cost) : `${usd(cost)} · ${counted}`;
};

export const modelFallbackText = (fallback: ModelFallback): string =>
  `The host refused ${fallback.requested}; ran on the host default`;

const EMPTY: RoleRunNote = { cost: null, fallback: null, fallbackDetail: null };

/** Each role run's note, by action id. */
export const roleRunNotes = (events: readonly VtcEvent[]): ReadonlyMap<string, RoleRunNote> => {
  const notes = new Map<string, RoleRunNote>();
  for (const { data } of eventsOfType(events, "role.dispatched")) {
    const fallback = data.model_fallback;
    notes.set(data.action_id, {
      ...(notes.get(data.action_id) ?? EMPTY),
      fallback: fallback === undefined ? null : modelFallbackText(fallback),
      fallbackDetail: fallback?.detail ?? null,
    });
  }
  for (const { event, data } of eventsOfType(events, "role.submitted")) {
    notes.set(data.action_id, {
      ...(notes.get(data.action_id) ?? EMPTY),
      cost: roleCostText(event.cost_usd, data.budget_usd),
    });
  }
  return notes;
};
