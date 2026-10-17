/**
 * The `lookback.*` events (AD-21), and the `automation.skipped` a replay limit logs (D-cg, spine §5
 * reading 201), as drafts the caller appends to the run's log. Lookback never appends events
 * itself: it returns drafts, typed against the frozen payloads, and engine core's event log
 * validates them on append.
 */
import type { EventDataInput } from "@vtc/shared";
import type { EventDraft } from "../core/index.js";

export type LookbackEventType =
  | "lookback.dispatched"
  | "lookback.proposal_recorded"
  | "lookback.replay_finished"
  | "lookback.canary_assigned"
  | "lookback.canary_evaluated"
  | "lookback.rolled_back"
  | "lookback.escaped_defect"
  | "lookback.unattributed"
  | "automation.skipped";

export type LookbackEventDraft = {
  [K in LookbackEventType]: {
    readonly type: K;
    readonly actor: "engine";
    readonly data: EventDataInput<K>;
    readonly task?: string;
    readonly feature?: string;
    readonly role?: string;
  };
}[LookbackEventType];

/** A draft for engine core's event log. */
export const lookbackEvent = <K extends LookbackEventType>(
  type: K,
  data: EventDataInput<K>,
  envelope: { readonly task?: string; readonly feature?: string; readonly role?: string } = {},
): Extract<LookbackEventDraft, { readonly type: K }> & EventDraft =>
  ({ type, actor: "engine", data, ...envelope }) as Extract<
    LookbackEventDraft,
    { readonly type: K }
  > &
    EventDraft;
