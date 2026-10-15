import type { VtcEvent } from "@vtc/shared";
import { NOTICE_EVENT_TYPES } from "../notices";

/**
 * Live refresh (§17 "live: the engine's event stream"). The engine owns every derived view
 * (graph states, task detail, usage), so the dashboard never replays events itself: an event
 * only marks the read routes it can change as stale, and the views re-read them.
 *
 * A run-scoped topic is `run:<run>:<name>`; `runs`, `usage` and `automation` (the repo's
 * automatic issues and PRs, `GET /api/automation`) are global.
 */
export type RunTopicName =
  | "status"
  | "graph"
  | "tasks"
  | "features"
  | "escalations"
  | "notices"
  | "gates"
  | "headless"
  | "level3"
  | "research"
  | "lookback"
  | `task:${string}`;

export const runTopic = (run: string, name: RunTopicName): string => `run:${run}:${name}`;

const TASK_SCOPED: readonly RunTopicName[] = ["tasks", "graph", "status"];

/**
 * The views that read the run's event log for wave-3 data (spine §5 reading 109) re-read it on
 * these topics: `gates` (G1/G2 requests, directions, unverified facts, the G2 coverage loop), `headless`
 * (engine-launched runs), `level3` (preflight, checklist, auto-merge, Final Review steps),
 * `research` (facts) and `lookback`.
 */
const LEVEL3_TYPES = new Set([
  "merge.preflight",
  "feature.checklist",
  "feature.auto_merge_enabled",
  "feature.auto_merge_disabled",
  "feature.post_merge_ci",
  "feature.reverted",
]);

const entityTopics = (event: VtcEvent): string[] => {
  const [entity] = event.type.split(".");
  const task = event.task === undefined ? [] : ([`task:${event.task}`] as const);
  switch (entity) {
    case "run":
      // The run's end settles what the event-log views show live: a gate still open no longer
      // waits, and a headless start with no end did not finish.
      return [
        "runs",
        "status",
        "graph",
        ...(event.type === "run.finished" ? ["gates", "headless"] : []),
      ];
    case "gate":
      return event.type === "gate.result"
        ? [...task, "graph"]
        : ["runs", "status", "graph", "gates"];
    case "task":
    case "contract":
    case "merge":
      return [
        ...TASK_SCOPED,
        ...task,
        ...(entity === "merge" ? ["features"] : []),
        ...(LEVEL3_TYPES.has(event.type) ? ["level3"] : []),
      ];
    case "feature":
    case "branch":
      return ["features", "graph", "status", ...(LEVEL3_TYPES.has(event.type) ? ["level3"] : [])];
    case "final_review":
      return ["features", "level3"];
    case "headless":
      return ["headless", "status", "graph", ...task];
    case "design":
      // A coverage check before G2 (H-13): the gates view shows the loop's status.
      return ["gates"];
    case "fact":
      return event.type === "fact.waived" ? ["research", "gates"] : ["research"];
    case "research":
      return ["research"];
    case "lookback":
      return ["lookback"];
    case "upstream":
    case "automation":
      return ["automation"];
    case "role":
      // A design role's submit can end a coverage fix round (H-13): the gates view re-reads.
      return [
        ...task,
        "graph",
        ...(event.type === "role.submitted" &&
        (event.role === "architect" || event.role === "designer")
          ? ["gates"]
          : []),
      ];
    case "finding":
      return [...task, "graph"];
    case "escalation":
    case "change_request":
    case "spec":
      return ["escalations", "status", ...task];
    case "budget":
      return ["tasks", "features", "status", ...task];
    case "usage":
    case "limit":
      return ["usage", "status", ...(entity === "limit" ? ["tasks", "graph", ...task] : [])];
    default:
      return [];
  }
};

/** The run-scoped topics an event makes stale (plus `runs`/`usage` markers, made global below). */
export const topicsForEvent = (event: VtcEvent): string[] => {
  const topics = entityTopics(event);
  return (NOTICE_EVENT_TYPES as ReadonlySet<string>).has(event.type)
    ? [...topics, "notices"]
    : topics;
};

const GLOBAL = new Set(["runs", "usage", "automation"]);

/** Full topic keys for an event: run-scoped names are prefixed with the run. */
export const topicKeysForEvent = (event: VtcEvent): string[] =>
  topicsForEvent(event).map((t) => (GLOBAL.has(t) ? t : runTopic(event.run, t as RunTopicName)));

export interface InvalidationBus {
  subscribe(topic: string, callback: () => void): () => void;
  invalidate(topics: readonly string[]): void;
}

/** Collects stale topics and notifies each subscriber once per burst (after `delayMs`). */
export const createInvalidationBus = (delayMs = 250): InvalidationBus => {
  const subscribers = new Map<string, Set<() => void>>();
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    timer = null;
    const callbacks = new Set<() => void>();
    for (const topic of pending) for (const cb of subscribers.get(topic) ?? []) callbacks.add(cb);
    pending.clear();
    for (const cb of callbacks) cb();
  };

  return {
    subscribe(topic, callback) {
      let set = subscribers.get(topic);
      if (set === undefined) {
        set = new Set();
        subscribers.set(topic, set);
      }
      set.add(callback);
      return () => {
        set.delete(callback);
      };
    },
    invalidate(topics) {
      for (const t of topics) pending.add(t);
      timer ??= setTimeout(flush, delayMs);
    },
  };
};
