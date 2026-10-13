/**
 * Front-half roles (DISCOVER, SPECIFY, DESIGN, PLAN) and advisors run in their own
 * engine-managed worktree, like task roles (spine §5 reading 21): `.vtc/state/worktrees/
 * R-<run>-<action>` on `vtc/R-<run>-<action>`, created at the user's HEAD with the front half's
 * current documents (research, spec, architecture, design, exports, the run's request) committed
 * on top as its base. When the run ends the engine commits what the role left, checks every
 * change against the role's write paths (never an engine path), and copies the changes into the
 * user's checkout. The user's own edits in the checkout therefore never count as a role's write;
 * a file the user changed while the role worked is never overwritten (the result is refused and
 * the run pauses, so the human reconciles first).
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitChangedFile } from "@vtc/shared";
import { removeRepoFile, writeRepoFile } from "../git/index.js";
import { ENGINE_ONLY_GLOBS, type DispatchRecord } from "./dispatch-guard.js";
import { matchesAny } from "./globs.js";
import type { Kernel } from "./kernel.js";

/** The documents a front-half role or advisor reads, copied into its worktree. */
export const ROLE_INPUT_DIRS = [
  ".vtc/research",
  ".vtc/spec",
  ".vtc/architecture",
  ".vtc/design",
  ".vtc/exports",
] as const;

export const roleWorktreeId = (run: string, actionId: string): string => `R-${run}-${actionId}`;

const filesUnder = (root: string, rel: string, depth: number): string[] => {
  let names: string[];
  try {
    names = readdirSync(join(root, rel));
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const child = `${rel}/${name}`;
    try {
      const stat = lstatSync(join(root, child));
      if (stat.isSymbolicLink()) return [];
      if (stat.isDirectory()) return depth > 0 ? filesUnder(root, child, depth - 1) : [];
      return stat.isFile() ? [child] : [];
    } catch {
      return [];
    }
  });
};

/** The role's worktree, at the user's HEAD with the current front-half documents as its base. */
export const prepareRoleWorktree = async (
  k: Kernel,
  run: string,
  actionId: string,
): Promise<NonNullable<DispatchRecord["worktree"]>> => {
  const ws = k.deps.workspace;
  const id = roleWorktreeId(run, actionId);
  const { worktree } = await ws.ensureTaskWorktree(id, `vtc/${id}`, await ws.resolve("HEAD"));
  const root = join(k.deps.repoRoot, worktree);
  const inputs = [
    ...ROLE_INPUT_DIRS.flatMap((dir) => filesUnder(k.deps.repoRoot, dir, 8)),
    ...filesUnder(k.deps.repoRoot, `.vtc/runs/${run}`, 0).filter((p) => p.endsWith(".md")),
  ];
  for (const path of inputs) {
    writeRepoFile(root, path, readFileSync(join(k.deps.repoRoot, path)));
  }
  const base = await ws.snapshot(worktree, `vtc: inputs of ${actionId}`);
  return { path: worktree, base };
};

export interface RoleChanges {
  readonly head: string;
  readonly changes: readonly GitChangedFile[];
}

/** Commits what the role left in its worktree; the changes since its base. */
export const collectRoleChanges = async (
  k: Kernel,
  worktree: NonNullable<DispatchRecord["worktree"]>,
  message: string,
): Promise<RoleChanges> => {
  const head = await k.deps.workspace.snapshot(worktree.path, message);
  return { head, changes: await k.deps.git.changedFiles(worktree.base, head) };
};

const touched = (change: GitChangedFile): string[] =>
  change.oldPath === undefined ? [change.path] : [change.oldPath, change.path];

/** Every change outside the role's write paths, or where only the engine writes. */
export const roleScopeIssues = (
  changes: readonly GitChangedFile[],
  writePaths: readonly string[],
): string[] =>
  changes
    .flatMap(touched)
    .flatMap((path) =>
      matchesAny(ENGINE_ONLY_GLOBS, path)
        ? [`${path} was written where only the engine writes`]
        : matchesAny(writePaths, path)
          ? []
          : [`${path} was written outside the role's write paths`],
    );

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined): boolean =>
  a === undefined || b === undefined ? a === b : Buffer.from(a).equals(Buffer.from(b));

const checkoutBytes = (k: Kernel, path: string): Uint8Array | undefined => {
  try {
    const stat = lstatSync(join(k.deps.repoRoot, path));
    return stat.isFile() ? readFileSync(join(k.deps.repoRoot, path)) : new Uint8Array([0]);
  } catch {
    return undefined;
  }
};

/**
 * Copies the role's changes into the user's checkout. Refuses (returns the paths, writes
 * nothing) when the user changed any of those files since the role's base.
 */
export const mergeRoleChanges = async (
  k: Kernel,
  worktree: NonNullable<DispatchRecord["worktree"]>,
  role: RoleChanges,
): Promise<{ readonly conflicts: string[] }> => {
  const paths = [...new Set(role.changes.flatMap(touched))];
  const conflicts: string[] = [];
  for (const path of paths) {
    const base = await k.deps.git.readFileAtCommit(worktree.base, path);
    if (!same(base, checkoutBytes(k, path))) conflicts.push(path);
  }
  if (conflicts.length > 0) return { conflicts };
  for (const path of paths) {
    const bytes = await k.deps.git.readFileAtCommit(role.head, path);
    if (bytes === undefined) removeRepoFile(k.deps.repoRoot, path);
    else writeRepoFile(k.deps.repoRoot, path, bytes);
  }
  return { conflicts: [] };
};
