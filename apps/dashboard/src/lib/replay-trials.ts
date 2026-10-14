import type { VtcEvent } from "@vtc/shared";
import { eventData } from "./events";

/**
 * Lookback replay trials are not the run's work (spine §5 reading 177): a `role.dispatched` with
 * `purpose: lookback_replay` changes no task, so Flow Studio and the task views leave it out, with
 * its `role.submitted` (and `role.rejected` / `role.failed`) and the engine-launched run that
 * carried it (`headless.started` / `headless.ended` of the same action), from the log alone.
 */
const ACTION_TYPES = new Set([
  "role.dispatched",
  "role.submitted",
  "role.rejected",
  "role.failed",
  "headless.started",
  "headless.ended",
]);

const actionId = (event: VtcEvent): string | null => {
  if (!ACTION_TYPES.has(event.type)) return null;
  const data = event.data as { action_id?: unknown };
  return typeof data.action_id === "string" ? data.action_id : null;
};

const isTrialDispatch = (event: VtcEvent): boolean =>
  eventData(event, "role.dispatched")?.purpose === "lookback_replay";

/** The log without replay trials; the same array when it has none. */
export const withoutReplayTrials = (events: readonly VtcEvent[]): readonly VtcEvent[] => {
  const trials = new Set(events.filter(isTrialDispatch).map(actionId));
  if (trials.size === 0) return events;
  return events.filter((e) => {
    const id = actionId(e);
    return id === null || !trials.has(id);
  });
};

/**
 * For the live stream: whether an arriving event belongs to a replay trial whose dispatch this
 * stream has seen, so it marks no task or graph view stale.
 */
export const createReplayTrialFilter = (): ((event: VtcEvent) => boolean) => {
  const trials = new Set<string>();
  return (event) => {
    const id = actionId(event);
    if (id === null) return false;
    if (isTrialDispatch(event)) trials.add(`${event.run}:${id}`);
    return trials.has(`${event.run}:${id}`);
  };
};
