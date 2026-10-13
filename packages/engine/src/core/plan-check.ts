/**
 * PLAN checks (§6.1): the engine accepts the Planner's task drafts only when every REQ is
 * covered, the DAG has no cycle, tasks that can run in parallel have disjoint write scopes, every
 * reference resolves and every consumed contract matches what its provider publishes. Pure.
 */
import type { TaskDraft } from "@vtc/shared";
import { scopesOverlap } from "./globs.js";

export interface PlanCheckInput {
  readonly drafts: readonly TaskDraft[];
  /** Requirement ids of the frozen spec; empty when the spec lists none (coverage unchecked). */
  readonly requirements: readonly string[];
  /** Ids already used in the repo (another run's tasks), which a draft may not reuse. */
  readonly takenIds?: readonly string[];
}

/** Ids reachable from `id` through `after` (what must finish before it). */
const ancestors = (id: string, byId: ReadonlyMap<string, TaskDraft>): Set<string> => {
  const seen = new Set<string>();
  const stack = [...(byId.get(id)?.after ?? [])];
  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined || seen.has(next)) continue;
    seen.add(next);
    stack.push(...(byId.get(next)?.after ?? []));
  }
  return seen;
};

/** A cycle through `after` and consumed contracts, as ids, or `null`. */
export const findDependencyCycle = (drafts: readonly TaskDraft[]): string[] | null => {
  const edges = new Map<string, string[]>();
  for (const d of drafts) {
    edges.set(d.id, [...d.after, ...d.consumes_contracts.map((c) => c.provider)]);
  }
  const color = new Map<string, number>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    color.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      if (!edges.has(next)) continue;
      const c = color.get(next) ?? 0;
      if (c === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (c === 0) {
        const found = visit(next);
        if (found !== null) return found;
      }
    }
    stack.pop();
    color.set(id, 2);
    return null;
  };
  for (const d of drafts) {
    if ((color.get(d.id) ?? 0) === 0) {
      const found = visit(d.id);
      if (found !== null) return found;
    }
  }
  return null;
};

/** Every problem with a plan; empty means the plan is accepted. */
export const checkPlan = (input: PlanCheckInput): string[] => {
  const issues: string[] = [];
  const { drafts } = input;
  if (drafts.length === 0) return ["the plan has no tasks"];
  const byId = new Map<string, TaskDraft>();
  for (const d of drafts) {
    if (byId.has(d.id)) issues.push(`duplicate task id ${d.id}`);
    byId.set(d.id, d);
    if (input.takenIds?.includes(d.id) === true) issues.push(`task id ${d.id} is already used`);
  }
  for (const d of drafts) {
    for (const dep of d.after) {
      if (!byId.has(dep)) issues.push(`${d.id} depends on unknown task ${dep}`);
    }
    for (const consumed of d.consumes_contracts) {
      const provider = byId.get(consumed.provider);
      if (provider === undefined) {
        issues.push(`${d.id} consumes a contract of unknown task ${consumed.provider}`);
      } else if (
        provider.provides_contract?.path !== consumed.path ||
        provider.provides_contract.kind !== consumed.kind
      ) {
        issues.push(
          `${d.id} consumes ${consumed.kind} ${consumed.path}, which ${consumed.provider} does not provide`,
        );
      }
    }
    if (input.requirements.length > 0) {
      for (const req of d.covers) {
        if (!input.requirements.includes(req)) issues.push(`${d.id} covers unknown ${req}`);
      }
    }
  }
  if (input.requirements.length > 0) {
    const covered = new Set(drafts.flatMap((d) => d.covers));
    for (const req of input.requirements) {
      if (!covered.has(req)) issues.push(`${req} is not covered by any task`);
    }
  }
  const cycle = findDependencyCycle(drafts);
  if (cycle !== null) issues.push(`dependency cycle: ${cycle.join(" → ")}`);
  else {
    // Two tasks may run in parallel unless one is an ancestor of the other.
    const before = new Map(drafts.map((d) => [d.id, ancestors(d.id, byId)]));
    for (const [i, a] of drafts.entries()) {
      for (const b of drafts.slice(i + 1)) {
        const ordered = before.get(a.id)?.has(b.id) === true || before.get(b.id)?.has(a.id) === true;
        if (!ordered && scopesOverlap(a.files_scope, b.files_scope)) {
          issues.push(`${a.id} and ${b.id} can run in parallel but their files_scope overlap`);
        }
      }
    }
  }
  return issues;
};
