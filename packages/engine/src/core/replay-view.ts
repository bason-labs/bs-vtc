/**
 * The run as the read models show it (spine §5 reading 177): without its Lookback replay trials.
 * A trial (`role.dispatched` with `purpose: lookback_replay`) measures a prompt version; it is no
 * work of the run, so status, the task views, Flow Studio and the event view leave out its
 * dispatch and every `role.*` and `headless.*` event of its action. The log itself keeps them.
 */
import type { VtcEvent } from "@vtc/shared";
import { applyEvent, emptyRunState, type RunState } from "./state.js";

/** The action ids of a log's replay trials (`role.dispatched.purpose`, contracts 4.11.0). */
export const replayTrialActionIds = (events: readonly VtcEvent[]): ReadonlySet<string> => {
  const ids = new Set<string>();
  for (const e of events) {
    if (e.type !== "role.dispatched") continue;
    const data = e.data as { purpose?: unknown; action_id?: unknown };
    if (data.purpose === "lookback_replay" && typeof data.action_id === "string")
      ids.add(data.action_id);
  }
  return ids;
};

/** Pure: the events without the replay trials' `role.*` and `headless.*` events. */
export const withoutReplayTrialEvents = (
  events: readonly VtcEvent[],
  trials: ReadonlySet<string> = replayTrialActionIds(events),
): readonly VtcEvent[] =>
  trials.size === 0
    ? events
    : events.filter((e) => {
        const action = (e.data as { action_id?: unknown } | undefined)?.action_id;
        return !(
          typeof action === "string" &&
          trials.has(action) &&
          (e.type.startsWith("role.") || e.type.startsWith("headless."))
        );
      });

const views = new WeakMap<RunState, { readonly lastSeq: number; readonly view: RunState }>();

/**
 * The run's state projected without its replay trials (the same state when it has none), cached
 * per state until its log grows.
 */
export const readModelState = (state: RunState): RunState => {
  const cached = views.get(state);
  if (cached?.lastSeq === state.lastSeq) return cached.view;
  const events = withoutReplayTrialEvents(state.events);
  let view = state;
  if (events !== state.events) {
    view = emptyRunState(state.id, state.run.started_at);
    for (const e of events) applyEvent(view, e);
  }
  views.set(state, { lastSeq: state.lastSeq, view });
  return view;
};
