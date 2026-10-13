/**
 * Write check of the roles that work in the user's checkout (AD-7 rule 7, AD-8; §6.3 step 4 for
 * the front half): Researcher, Cartographer, BA, Architect, Designer and Planner, and a BA or
 * Designer answering a task's spec or design gap. When the engine dispatches one it records the
 * checkout: HEAD and a content hash of every changed or untracked file, the git files that change
 * what git runs or sees (`gitConfigFingerprint`: config, hooks, attributes, excludes), and the
 * engine's own state files under `.vtc/state/` that it reads back. Every check compares that
 * record with the checkout now. A changed path passes only when:
 *
 * - it holds exactly what the engine itself last wrote there (`EngineWrites`): the event log,
 *   plan files, packs, results, evidence, design reviews. Being under an engine directory is not
 *   enough, and a path only the engine writes ({@link ENGINE_ONLY_GLOBS}) never passes otherwise;
 * - or it is inside the role's effective `write_paths`, or those of another checkout role that
 *   ran at the same time (two concurrent runs in one checkout cannot be told apart).
 *
 * A change to the git files fails the check before git is run again, and every engine git call
 * in the repo is refused while it stands (`setGitPreflight`): a planted hook, signing program or
 * filter driver never runs. The check runs for every run that ends: an accepted or rejected
 * submit, a failure (crash, limit, sign-in), a run superseded by `resume`, or one interrupted by
 * a limit; a run whose record was not checked yet is checked before the next dispatch records a
 * new baseline. Its record is removed only after that. Anything the check finds pauses the run
 * with the paths: nothing is restored automatically (a user's own edit counts as the role's and
 * must not be lost), and only the human's `resume` takes the checkout as it then is.
 *
 * Other ignored files under `.vtc/state/` (task worktrees and clean checkouts, which are verified
 * on their own; QA's hidden-test staging; Gate Runner raw output; the index database) are outside
 * this check. Records live in memory and, for a restart, in `.vtc/state/scopes/<action_id>.json`.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { SlugSchema } from "@vtc/shared";
import {
  fingerprintChanges,
  GitConfigChangedError,
  gitConfigFingerprint,
  removeRepoFile,
  runGit,
  writeRepoFile,
} from "../git/index.js";
import { LEDGER_PATH, type EngineWrites } from "./engine-writes.js";
import { globMatch } from "./globs.js";

export interface CheckoutRecord {
  readonly v: 2;
  /** HEAD of the checkout, or `null` before the first commit. */
  readonly head: string | null;
  /** Changed or untracked paths → content hash (`deleted` when the path is gone). */
  readonly files: Readonly<Record<string, string>>;
  /** `gitConfigFingerprint` of the repo. */
  readonly git: Readonly<Record<string, string>>;
  /** The engine's own state files ({@link WATCHED_STATE_DIRS}) → content hash. */
  readonly state: Readonly<Record<string, string>>;
  /** For a BA answering a task's gap: the frozen spec's item ids at dispatch (§6.2). */
  readonly spec_ids?: readonly string[];
}

export const SCOPES_DIR = ".vtc/state/scopes";
const GIT_HOLD_PATH = `${SCOPES_DIR}/git-hold.json`;

/** Paths only the engine writes in the checkout: a role's write there never passes. */
export const ENGINE_ONLY_GLOBS = [
  ".vtc/runs/**",
  ".vtc/tasks/**",
  ".vtc/evidence/**",
  ".vtc/design/reviews/**",
  ".vtc/state/**",
] as const;

/** Ignored engine state the engine reads back as input, checked like tracked files. */
export const WATCHED_STATE_DIRS = [
  ".vtc/state/results",
  ".vtc/state/scopes",
  ".vtc/state/runs",
  ".vtc/state/packs",
] as const;

/** Roles that work in the user's checkout rather than a task worktree (§6.1). */
export const CHECKOUT_ROLES: readonly string[] = [
  "repo_cartographer",
  "research_analyst",
  "ba",
  "architect",
  "designer",
  "planner",
];

export const runsInCheckout = (role: string): boolean => CHECKOUT_ROLES.includes(role);

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

const stateFiles = (repoRoot: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(join(repoRoot, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const child = `${rel}/${name}`;
      let directory: boolean;
      try {
        const stat = lstatSync(join(repoRoot, child));
        directory = stat.isDirectory() && !stat.isSymbolicLink();
      } catch {
        continue;
      }
      if (directory) {
        if (depth > 0) walk(child, depth - 1);
      } else {
        out[child] = hashOf(join(repoRoot, child));
      }
    }
  };
  for (const dir of WATCHED_STATE_DIRS) walk(dir, 3);
  const ledger = join(repoRoot, LEDGER_PATH);
  if (existsSync(ledger)) out[LEDGER_PATH] = hashOf(ledger);
  return out;
};

/** Records the checkout now (see the module doc). */
export const recordCheckout = async (repoRoot: string): Promise<CheckoutRecord> => {
  const git = gitConfigFingerprint(repoRoot);
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
  return {
    v: 2,
    head: head.code === 0 && sha !== "" ? sha : null,
    files,
    git,
    state: stateFiles(repoRoot),
  };
};

/** Paths that differ between two records (content, presence, or commits in between). */
export const changedPaths = async (
  repoRoot: string,
  before: CheckoutRecord,
  after: CheckoutRecord,
): Promise<string[]> => {
  const changed = new Set<string>(fingerprintChanges(before.state, after.state));
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

const engineOnly = (path: string): boolean => ENGINE_ONLY_GLOBS.some((g) => globMatch(g, path));

/** What a check found. */
export interface WriteFindings {
  /** One line per offending path. */
  readonly issues: string[];
  /** Git files that changed (engine git is refused until the human resumes). */
  readonly git: string[];
}

/**
 * Every write in the checkout since `before` that is neither the engine's own (per the ledger)
 * nor inside `allowed` (see the module doc).
 */
export const checkoutWrites = async (
  repoRoot: string,
  writes: EngineWrites,
  before: CheckoutRecord,
  allowed: readonly string[],
): Promise<WriteFindings> => {
  const git = fingerprintChanges(before.git, gitConfigFingerprint(repoRoot));
  if (git.length > 0) {
    // Git is not run on a changed config: report what changed and stop here.
    return {
      issues: git.map((path) => `${path} was changed (git configuration, hooks or attributes)`),
      git,
    };
  }
  const changed = await changedPaths(repoRoot, before, await recordCheckout(repoRoot));
  const issues: string[] = [];
  for (const path of changed) {
    if (writes.has(path)) {
      const check = writes.check(path);
      if (check.ok) continue;
      issues.push(`${path} changed outside the engine: ${check.detail}`);
      continue;
    }
    if (engineOnly(path)) {
      issues.push(`${path} was written where only the engine writes`);
      continue;
    }
    if (!allowed.some((g) => globMatch(g, path)))
      issues.push(`${path} was written outside the role's write paths`);
  }
  return { issues, git: [] };
};

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

/** Drops a checked record (memory and file). */
export const dropCheckoutRecord = (
  repoRoot: string,
  memory: Map<string, CheckoutRecord>,
  actionId: string,
): void => {
  memory.delete(actionId);
  removeRepoFile(repoRoot, relOf(actionId));
};

const isHashes = (value: unknown): value is Record<string, string> =>
  value !== null &&
  typeof value === "object" &&
  Object.values(value as Record<string, unknown>).every((h) => typeof h === "string");

const isRecord = (value: unknown): value is CheckoutRecord => {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  return (
    r.v === 2 &&
    (r.head === null || typeof r.head === "string") &&
    isHashes(r.files) &&
    isHashes(r.git) &&
    isHashes(r.state) &&
    (r.spec_ids === undefined ||
      (Array.isArray(r.spec_ids) && r.spec_ids.every((i) => typeof i === "string")))
  );
};

/** Every record kept on disk (a restart), by action id. Unreadable ones are skipped. */
export const loadCheckoutRecords = (repoRoot: string): Map<string, CheckoutRecord> => {
  const out = new Map<string, CheckoutRecord>();
  let names: string[];
  try {
    names = readdirSync(join(repoRoot, SCOPES_DIR));
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json") || `${SCOPES_DIR}/${name}` === GIT_HOLD_PATH) continue;
    const id = name.slice(0, -".json".length);
    if (!SlugSchema.safeParse(id).success) continue;
    try {
      const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, SCOPES_DIR, name), "utf8"));
      if (isRecord(parsed)) out.set(id, parsed);
    } catch {
      // unreadable: no record
    }
  }
  return out;
};

/** The git fingerprint kept after a reported change, until the human resumes (or `null`). */
export const loadGitHold = (repoRoot: string): Record<string, string> | null => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(repoRoot, GIT_HOLD_PATH), "utf8"));
    return isHashes(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

export const saveGitHold = (
  repoRoot: string,
  hold: Readonly<Record<string, string>> | null,
): void => {
  if (hold === null) removeRepoFile(repoRoot, GIT_HOLD_PATH);
  else writeRepoFile(repoRoot, GIT_HOLD_PATH, `${JSON.stringify(hold)}\n`, 0o600);
};

/**
 * The preflight of every engine git call while a role works in the checkout, or while a git
 * change found by a check awaits the human: throws when the git files differ from any baseline.
 */
export const assertGitUnchanged = (
  repoRoot: string,
  baselines: readonly Readonly<Record<string, string>>[],
): void => {
  if (baselines.length === 0) return;
  const now = gitConfigFingerprint(repoRoot);
  const changed = new Set(baselines.flatMap((b) => fingerprintChanges(b, now)));
  if (changed.size > 0) throw new GitConfigChangedError([...changed].sort());
};
