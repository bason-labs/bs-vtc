/**
 * Scheduler (§6.5, §6.6, §6.9, §11; AD-8 rule 12). Pure: which waiting tasks may start now.
 * - `after` is satisfied when every listed task is merged or done
 *   (`DEPENDENCY_RELEASED_STATUSES`); a consumed contract when its provider froze it
 *   (`contract.frozen`), so consumers start contract-first;
 * - never two tasks with overlapping `files_scope` at once;
 * - concurrency (default 2, max 3) counts role runs in flight, reviewers included; work already
 *   in progress goes first, so a new task starts only on a free slot;
 * - below the usage reserve of the 5-hour window only in-flight steps continue;
 * - a parked task blocks only its transitive dependents (§6.5).
 */
import { DEPENDENCY_RELEASED_STATUSES, type Task, type TaskStatus } from "@vtc/shared";
import { scopesOverlap } from "./globs.js";
import { ACTIVE_TASK_STATUSES } from "./machines.js";

const released = (status: TaskStatus): boolean =>
  (DEPENDENCY_RELEASED_STATUSES as readonly TaskStatus[]).includes(status);

/** Tasks that have not started yet. */
const NOT_STARTED: readonly TaskStatus[] = ["draft", "waiting_dependency"];

export interface DependencyView {
  readonly tasks: ReadonlyMap<string, Pick<Task, "id" | "status" | "after" | "consumes_contracts">>;
  /** Provider tasks whose interface contract is frozen. */
  readonly frozenContracts: ReadonlySet<string>;
}

/** True when every `after` task is released and every consumed contract is frozen. */
export const dependenciesMet = (
  task: Pick<Task, "after" | "consumes_contracts">,
  view: DependencyView,
): boolean =>
  task.after.every((id) => {
    const dep = view.tasks.get(id);
    return dep !== undefined && released(dep.status);
  }) && task.consumes_contracts.every((c) => view.frozenContracts.has(c.provider));

/** Every task that (transitively) depends on `id` through `after` or a consumed contract. */
export const transitiveDependents = (
  id: string,
  tasks: Iterable<Pick<Task, "id" | "after" | "consumes_contracts">>,
): string[] => {
  const all = [...tasks];
  const out: string[] = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const task of all) {
      const depends =
        task.after.includes(current ?? "") ||
        task.consumes_contracts.some((c) => c.provider === current);
      if (depends && !out.includes(task.id) && task.id !== id) {
        out.push(task.id);
        queue.push(task.id);
      }
    }
  }
  return out;
};

export interface ScheduleInput extends DependencyView {
  /** In plan order. */
  readonly order: readonly string[];
  readonly scopes: ReadonlyMap<string, readonly string[]>;
  readonly concurrency: number;
  /** Role runs in flight plus dispatches already promised this call. */
  readonly busySlots: number;
  /** Remaining % of the 5-hour window of the dispatching host; `null` = unknown. */
  readonly remainingPct: number | null;
  readonly reservePct: number;
  readonly paused: boolean;
}

export interface ScheduleDecision {
  /** Tasks to start now (→ `ready`), in plan order. */
  readonly start: string[];
  /** Not-started tasks whose dependencies are not met (→ `waiting_dependency`). */
  readonly waiting: string[];
  /** Why nothing new starts, when that is the case. */
  readonly held: "paused" | "usage_reserve" | "no_slot" | null;
}

/**
 * Which not-started tasks start now. Unknown usage does not hold work back (unknown is shown as
 * unknown, never as 0%, §6.9); a known value below the reserve does.
 */
export const schedule = (input: ScheduleInput): ScheduleDecision => {
  const waiting: string[] = [];
  const candidates: string[] = [];
  for (const id of input.order) {
    const task = input.tasks.get(id);
    if (task === undefined || !NOT_STARTED.includes(task.status)) continue;
    if (dependenciesMet(task, input)) candidates.push(id);
    else if (task.status !== "waiting_dependency") waiting.push(id);
  }
  if (input.paused) return { start: [], waiting, held: "paused" };
  if (input.remainingPct !== null && input.remainingPct < input.reservePct) {
    return { start: [], waiting, held: candidates.length > 0 ? "usage_reserve" : null };
  }
  const active = input.order.filter((id) => {
    const task = input.tasks.get(id);
    return task !== undefined && ACTIVE_TASK_STATUSES.includes(task.status);
  });
  const start: string[] = [];
  let free = input.concurrency - input.busySlots;
  for (const id of candidates) {
    if (free <= 0) break;
    const scope = input.scopes.get(id) ?? [];
    const clash = [...active, ...start].some((other) =>
      scopesOverlap(scope, input.scopes.get(other) ?? []),
    );
    if (clash) continue;
    start.push(id);
    free -= 1;
  }
  const held = start.length === 0 && candidates.length > 0 && free <= 0 ? "no_slot" : null;
  return { start, waiting, held };
};
