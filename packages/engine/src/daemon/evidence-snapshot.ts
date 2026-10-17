/**
 * What the evidence browser of an automatic run's PR sees (AD-27 rule 6; D-ce, spine §5 reading
 * 208 (4)): the run's read routes, frozen from the engine's read model and keyed as the dashboard
 * asks for them, and the run's events for the replay. The upstream module serves them from its
 * loopback snapshot server (redacted there), never the live API. Only the run's own views, since
 * the evidence is published for good (the `vtc-evidence` branch or attachments): the run list
 * holds that run alone, the status only when the active run is this one, the Automation view
 * only the items and skips the run's own events record; the usage view is the hosts' windows the
 * run's `usage.updated` events carry anyway. No diff or artifact content, no client spend.
 */
import { ENGINE_HTTP, EVENT_PAGE_LIMIT, type VtcEvent } from "@vtc/shared";
import { automationReportView, type ReadModel, type ReadResult } from "../core/index.js";

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
  const runs = model.runs();
  routes[pathOf("runs")] = { ...runs, runs: runs.runs.filter((r) => r.id === run) };
  // the hosts' usage windows, as the run's own `usage.updated` events carry them too
  routes[pathOf("usage")] = model.usage();
  // the active run's summary, only when it is this run
  const status = model.status();
  if (status.ok && status.body.run.id === run) routes[pathOf("status")] = status.body;
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
  // the settings as they are, with only this run's automatic items and skips
  const own = automationReportView(events, null);
  routes[pathOf("automation")] = {
    ...model.automation(),
    items: own.items,
    skipped: own.skipped,
  };
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
