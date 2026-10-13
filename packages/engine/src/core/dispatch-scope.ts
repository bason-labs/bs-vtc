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
import { parsePersisted, taskPackPath, TaskPackSchema, type TaskPack } from "@vtc/shared";
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
   * Globs the role writes in the main checkout, relative to the repo root: entries under the
   * git-ignored `.vtc/state/` outside the worktrees, i.e. QA author mode's
   * `HIDDEN_TESTS.stagingDir/<task>/**` (reading 65).
   */
  readonly checkout_globs: readonly string[];
}

/** True for a scope entry written in the main checkout rather than in the role's worktree. */
export const isCheckoutScopeEntry = (glob: string): boolean =>
  glob.startsWith(".vtc/state/") && !glob.startsWith(`${WORKTREES_DIR}/`);

/** Splits a pack's `files_scope` into worktree globs and main-checkout entries. */
export const splitWriteScope = (
  filesScope: readonly string[],
): { worktree: string[]; checkout: string[] } => ({
  worktree: filesScope.filter((g) => !isCheckoutScopeEntry(g)),
  checkout: filesScope.filter(isCheckoutScopeEntry),
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
  const split = splitWriteScope(pack.files_scope);
  return {
    action_id: roleRun.action_id,
    worktree: dispatchWorktree(run, roleRun),
    worktree_globs: split.worktree,
    checkout_globs: split.checkout,
  };
};
