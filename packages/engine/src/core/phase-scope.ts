/**
 * Write-scope check of phase roles (AD-7 rule 7, AD-8; §6.3 step 4 for the front half).
 * Researcher, Cartographer, BA, Architect, Designer and Planner run in the user's checkout, not in
 * a task worktree, so the engine records the checkout when it dispatches one (HEAD plus a content
 * hash of every changed or untracked file) and compares it on submit: every path that changed
 * must be inside the role's effective `write_paths`, or inside those of another phase role that
 * ran at the same time (two concurrent runs in one checkout cannot be told apart). Paths the
 * engine itself writes during a run are not the role's. Ignored files (`.vtc/state/`, build
 * output) are outside git's view and outside this check. A write by anyone else in the checkout
 * while the role runs (the user, the Lead) counts as the role's: the rejection names the paths,
 * and the re-dispatch starts from the checkout as it is then.
 *
 * The record lives in memory and, for a restart, in `.vtc/state/scopes/<action_id>.json`.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { SlugSchema } from "@vtc/shared";
import { runGit, writeRepoFile } from "../git/index.js";
import { globMatch } from "./globs.js";

export interface CheckoutRecord {
  readonly v: 1;
  /** HEAD of the checkout, or `null` before the first commit. */
  readonly head: string | null;
  /** Changed or untracked paths → content hash (`deleted` when the path is gone). */
  readonly files: Readonly<Record<string, string>>;
}

export const SCOPES_DIR = ".vtc/state/scopes";

/** What the engine writes in the checkout during a run (never a role's write). */
export const ENGINE_WRITTEN_GLOBS = [
  ".vtc/runs/**",
  ".vtc/tasks/**",
  ".vtc/evidence/**",
  ".vtc/design/reviews/**",
  ".vtc/state/**",
] as const;

const hashOf = (abs: string): string => {
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(abs)}`;
    if (stat.isDirectory()) return "dir";
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return "deleted";
  }
};

/** Records the checkout now: HEAD and every changed or untracked file's content hash. */
export const recordCheckout = async (repoRoot: string): Promise<CheckoutRecord> => {
  const head = await runGit(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], {
    allowFailure: true,
  });
  const status = await runGit(repoRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  const files: Record<string, string> = {};
  for (const entry of status.stdout.toString("utf8").split("\0")) {
    if (entry.length < 4) continue;
    const path = entry.slice(3);
    files[path] = hashOf(join(repoRoot, path));
  }
  const sha = head.stdout.toString("utf8").trim();
  return { v: 1, head: head.code === 0 && sha !== "" ? sha : null, files };
};

/** Paths that differ between two records (content, presence, or commits in between). */
export const changedPaths = async (
  repoRoot: string,
  before: CheckoutRecord,
  after: CheckoutRecord,
): Promise<string[]> => {
  const changed = new Set<string>();
  for (const path of new Set([...Object.keys(before.files), ...Object.keys(after.files)])) {
    if (before.files[path] !== after.files[path]) changed.add(path);
  }
  if (before.head !== after.head) {
    if (before.head === null || after.head === null) {
      changed.add("(HEAD)");
    } else {
      const diff = await runGit(
        repoRoot,
        ["diff", "--name-only", "-z", "--no-renames", before.head, after.head],
        { allowFailure: true },
      );
      if (diff.code !== 0) changed.add("(HEAD)");
      for (const path of diff.stdout.toString("utf8").split("\0"))
        if (path !== "") changed.add(path);
    }
  }
  return [...changed].sort();
};

/** Paths a phase role changed outside `allowed` (engine-written paths excluded). */
export const outsideScope = (changed: readonly string[], allowed: readonly string[]): string[] =>
  changed.filter(
    (path) =>
      !ENGINE_WRITTEN_GLOBS.some((g) => globMatch(g, path)) &&
      !allowed.some((g) => globMatch(g, path)),
  );

const relOf = (actionId: string): string => `${SCOPES_DIR}/${SlugSchema.parse(actionId)}.json`;

/** Keeps the record of a dispatch (memory first, the file for a restart). */
export const saveCheckoutRecord = (
  repoRoot: string,
  memory: Map<string, CheckoutRecord>,
  actionId: string,
  record: CheckoutRecord,
): void => {
  memory.set(actionId, record);
  writeRepoFile(repoRoot, relOf(actionId), `${JSON.stringify(record)}\n`, 0o600);
};

const isRecord = (value: unknown): value is CheckoutRecord => {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 1 &&
    (r.head === null || typeof r.head === "string") &&
    r.files !== null &&
    typeof r.files === "object" &&
    Object.values(r.files).every((h) => typeof h === "string")
  );
};

export const loadCheckoutRecord = (
  repoRoot: string,
  memory: ReadonlyMap<string, CheckoutRecord>,
  actionId: string,
): CheckoutRecord | undefined => {
  const hit = memory.get(actionId);
  if (hit !== undefined) return hit;
  const abs = join(repoRoot, relOf(actionId));
  if (!existsSync(abs)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(abs, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};
