/**
 * What the evidence browser of an automatic run's PR sees (AD-27 rule 6; D-ce, spine §5 reading
 * 208 (4)): the run's read routes, frozen from the engine's read model and keyed as the dashboard
 * asks for them, and the run's events for the replay. The upstream module serves them from its
 * loopback snapshot server (redacted there), never the live API. Only the run's own views: no
 * diff or artifact content, no client spend.
 */
import { ENGINE_HTTP, EVENT_PAGE_LIMIT, type VtcEvent } from "@vtc/shared";
import type { ReadModel, ReadResult } from "../core/index.js";

export interface EvidenceSnapshot {
  /** By `pathname` or `pathname?search`, as the snapshot server looks them up. */
  readonly routes: Readonly<Record<string, unknown>>;
  readonly events: readonly VtcEvent[];
}

/** The most event pages a snapshot holds (the dashboard reads at most as many). */
const MAX_EVENT_PAGES = 50;

const pathOf = (
  route: keyof typeof ENGINE_HTTP.routes,
  params: Readonly<Record<string, string>> = {},
): string =>
  ENGINE_HTTP.routes[route].path.replace(/:([a-z]+)/g, (_m, name: string) =>
    encodeURIComponent(params[name] ?? ""),
  );

/** Pure: the run's read routes and events from `model` (a run it does not know: none). */
export const evidenceSnapshot = (model: ReadModel, run: string): EvidenceSnapshot => {
  const routes: Record<string, unknown> = {};
  const put = <T>(key: string, read: ReadResult<T>): void => {
    if (read.ok) routes[key] = read.body;
  };
  routes[pathOf("health")] = model.health();
  routes[pathOf("runs")] = model.runs();
  routes[pathOf("usage")] = model.usage();
  routes[pathOf("automation")] = model.automation();
  put(pathOf("status"), model.status());
  // every page the dashboard asks for (`?after=<n>&limit=<max>`); the first one also by its path
  const eventsPath = pathOf("runEvents", { run });
  const events: VtcEvent[] = [];
  let after = 0;
  for (let page = 0; page < MAX_EVENT_PAGES; page += 1) {
    const read = model.events(run, after, EVENT_PAGE_LIMIT.max);
    if (!read.ok) break;
    if (page === 0) routes[eventsPath] = read.body;
    routes[`${eventsPath}?after=${String(after)}&limit=${String(EVENT_PAGE_LIMIT.max)}`] =
      read.body;
    events.push(...read.body.events);
    if (read.body.next_after === null || read.body.next_after <= after) break;
    after = read.body.next_after;
  }
  const tasks = model.tasks(run);
  put(pathOf("tasks", { run }), tasks);
  for (const task of tasks.ok ? tasks.body.tasks : [])
    put(pathOf("task", { run, task: task.id }), model.task(run, task.id));
  put(pathOf("features", { run }), model.features(run));
  put(pathOf("escalations", { run }), model.escalations(run));
  const graph = pathOf("graph", { run });
  for (const scope of ["project", "task_dag"])
    put(`${graph}?scope=${scope}`, model.graph(run, scope, undefined));
  put(graph, model.graph(run, "project", undefined));
  for (const task of tasks.ok ? tasks.body.tasks : [])
    put(
      `${graph}?scope=task&task=${encodeURIComponent(task.id)}`,
      model.graph(run, "task", task.id),
    );
  return { routes, events };
};
