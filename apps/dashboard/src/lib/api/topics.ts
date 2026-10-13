import type { VtcEvent } from "@vtc/shared";

/**
 * Live refresh (§17 "live: the engine's event stream"). The engine owns every derived view
 * (graph states, task detail, usage), so the dashboard never replays events itself: an event
 * only marks the read routes it can change as stale, and the views re-read them.
 *
 * A run-scoped topic is `run:<run>:<name>`; `runs` and `usage` are global.
 */
export type RunTopicName =
  "status" | "graph" | "tasks" | "features" | "escalations" | `task:${string}`;

export const runTopic = (run: string, name: RunTopicName): string => `run:${run}:${name}`;

const TASK_SCOPED: readonly RunTopicName[] = ["tasks", "graph", "status"];

/** The run-scoped topics an event makes stale (plus `runs`/`usage` markers, made global below). */
export const topicsForEvent = (event: VtcEvent): string[] => {
  const [entity] = event.type.split(".");
  const task = event.task === undefined ? [] : ([`task:${event.task}`] as const);
  switch (entity) {
    case "run":
      return ["runs", "status", "graph"];
    case "gate":
      return event.type === "gate.result" ? [...task, "graph"] : ["runs", "status", "graph"];
    case "task":
    case "contract":
    case "merge":
      return [...TASK_SCOPED, ...task, ...(entity === "merge" ? ["features"] : [])];
    case "feature":
    case "branch":
      return ["features", "graph", "status"];
    case "role":
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

const GLOBAL = new Set(["runs", "usage"]);

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
