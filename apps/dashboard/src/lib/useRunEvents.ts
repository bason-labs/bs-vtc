"use client";

import { runTopic, type RunTopicName } from "./api/topics";
import { loadRunEvents, type RunEventLog } from "./notices";
import { useResource, type Resource } from "./useResource";

/**
 * The run's whole event log (`GET /api/runs/:run/events`, every page), re-read when one of
 * `topics` goes stale. Wave-3 views build from events (spine §5 reading 109): no new route.
 * `truncated` says the newest events were not read ({@link EventLogTruncated}).
 */
export function useRunEvents(
  run: string | null,
  topics: readonly RunTopicName[],
): Resource<RunEventLog> {
  const key = run ?? "";
  return useResource(
    run === null ? null : `events:${key}:${topics.join(",")}`,
    (c, s) => loadRunEvents(c, key, s),
    run === null ? [] : topics.map((t) => runTopic(key, t)),
  );
}
