/**
 * A dispatch's effective write scope as structured data (spine §5 readings 53, 65 and 67), for
 * `vtc hook` (hook rule 4), so the hook needs neither its own copy of the glob dialect nor a
 * parser for the rendered Markdown pack. The engine persists every pack it renders as JSON next to
 * the Markdown (`.vtc/state/packs/<action_id>.json`, gitignored, an engine file the dispatch guard
 * checks like the pack itself, AD-7 rule 7). The engine's own write-scope check on submit stays
 * the enforcement point; the hook is defence in depth.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HIDDEN_TESTS,
  parsePersisted,
  taskPackPath,
  TaskPackSchema,
  type TaskPack,
} from "@vtc/shared";
import { WORKTREES_DIR } from "../git/index.js";
import { roleWorktreeId } from "./role-worktree.js";
import type { RoleRunRecord, RunState } from "./state.js";

/** `.vtc/state/packs/<action_id>.json`: the pack the engine rendered, as `TaskPack` JSON. */
export const taskPackJsonPath = (actionId: string): string =>
  taskPackPath(actionId).replace(/\.md$/, ".json");

export interface DispatchWriteScope {
  readonly action_id: string;
  /**
   * The worktree the role works in, repo-relative (`.vtc/state/worktrees/<id>`): the task's
   * worktree, or a phase role's or advisor's own (spine §5 reading 21). `null` when the role
   * works in the main checkout (a task with no worktree yet).
   */
  readonly worktree: string | null;
  /** Globs the role may write, relative to its worktree root. */
  readonly worktree_globs: readonly string[];
  /**
   * Globs the role writes in the main checkout, relative to the repo root: only QA author mode's
   * own `HIDDEN_TESTS.stagingDir/<task>/**` (readings 53 and 65), never another entry.
   */
  readonly checkout_globs: readonly string[];
}

/** Who a scope belongs to: the dispatch's role, mode and task. */
export type ScopeOwner = Pick<RoleRunRecord, "role" | "mode" | "task">;

/**
 * True for the one scope entry a role writes in the main checkout rather than in its worktree:
 * QA author mode's staging entry for its own task, `HIDDEN_TESTS.stagingDir/<task>/**` (readings
 * 53 and 65). Any other entry under the engine's `.vtc/state/` (the lock, the index, the clean
 * checkouts, another task's staging) is neither: a Planner-authored `files_scope` never reaches
 * the engine's files.
 */
export const isCheckoutScopeEntry = (glob: string, owner: ScopeOwner): boolean =>
  owner.role === "qa" &&
  owner.mode === "author" &&
  owner.task !== undefined &&
  glob === `${HIDDEN_TESTS.stagingDir}/${owner.task}/**`;

/** True for an entry under the engine's state directory (never a role's to write). */
const isEngineStateEntry = (glob: string): boolean =>
  glob === ".vtc/state" || glob.startsWith(".vtc/state/");

/**
 * Splits a pack's `files_scope` into worktree globs and main-checkout entries
 * ({@link isCheckoutScopeEntry}); every other `.vtc/state/` entry goes in neither list.
 */
export const splitWriteScope = (
  filesScope: readonly string[],
  owner: ScopeOwner,
): { worktree: string[]; checkout: string[] } => ({
  worktree: filesScope.filter((g) => !isEngineStateEntry(g)),
  checkout: filesScope.filter((g) => isCheckoutScopeEntry(g, owner)),
});

/** The worktree a role run works in (see {@link DispatchWriteScope.worktree}). */
export const dispatchWorktree = (run: RunState, roleRun: RoleRunRecord): string | null => {
  if (roleRun.task !== undefined) return run.tasks.get(roleRun.task)?.worktree ?? null;
  return `${WORKTREES_DIR}/${roleWorktreeId(run.id, roleRun.action_id)}`;
};

/** The persisted pack of a dispatch, or `null` when it is missing, broken or another's. */
export const readDispatchPack = (
  repoRoot: string,
  run: RunState,
  roleRun: RoleRunRecord,
): TaskPack | null => {
  try {
    const parsed = parsePersisted(
      TaskPackSchema,
      JSON.parse(readFileSync(join(repoRoot, taskPackJsonPath(roleRun.action_id)), "utf8")),
    );
    if (!parsed.success) return null;
    const pack = parsed.data;
    return pack.run === run.id &&
      pack.action_id === roleRun.action_id &&
      pack.role === roleRun.role &&
      pack.task === roleRun.task
      ? pack
      : null;
  } catch {
    return null;
  }
};

/**
 * A dispatch's effective write scope (hook rule 4): its worktree and the pack's `files_scope`,
 * split into worktree globs and main-checkout entries. `null` when the persisted pack is missing,
 * unreadable or does not belong to this dispatch (the caller then fails open; the engine still
 * checks on submit). Match paths with `matchesAny` / `globToRegExp` from the same entry: the
 * engine's own glob dialect.
 */
export const dispatchWriteScope = (
  repoRoot: string,
  run: RunState,
  roleRun: RoleRunRecord,
): DispatchWriteScope | null => {
  const pack = readDispatchPack(repoRoot, run, roleRun);
  if (pack === null) return null;
  const split = splitWriteScope(pack.files_scope, roleRun);
  return {
    action_id: roleRun.action_id,
    worktree: dispatchWorktree(run, roleRun),
    worktree_globs: split.worktree,
    checkout_globs: split.checkout,
  };
};
