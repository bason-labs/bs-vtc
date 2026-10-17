/**
 * Which repo a `vtc` command acts on (AD-12: one daemon per repo). The repo root is the main
 * working tree of the git repository containing `cwd`, also when `cwd` is inside one of the
 * engine's own worktrees (`.vtc/state/worktrees/<id>`, git worktrees of the same repo): the
 * shared git directory (`--git-common-dir`) names the main working tree.
 */
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { core } from "@vtc/engine";
import { exec, type Exec } from "./process.js";

/** The repo's absolute, symlink-resolved root, or `null` when `cwd` is not in a git work tree. */
export const findRepoRoot = async (cwd: string, run: Exec = exec): Promise<string | null> => {
  const result = await run(
    "git",
    ["rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"],
    { cwd, timeoutMs: 5_000 },
  );
  if (result.code !== 0) return null;
  const [commonDir, topLevel] = result.stdout.trim().split(/\r?\n/);
  if (commonDir === undefined || topLevel === undefined || topLevel === "") return null;
  const root = basename(commonDir) === ".git" ? dirname(commonDir) : topLevel;
  try {
    return realpathSync(root);
  } catch {
    return null;
  }
};

/** {@link findRepoRoot} that throws a message fit for the user. */
export const requireRepoRoot = async (cwd: string, run: Exec = exec): Promise<string> => {
  const root = await findRepoRoot(cwd, run);
  if (root === null) throw new Error(`${cwd} is not inside a git repository`);
  return root;
};

/** A usage error (bad flags or arguments): the command prints its message and exits 64. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

/**
 * True when `vtc init` set the repo up: `.vtc/project.yaml` is a plain file. The plugins are
 * user-scoped, so their MCP entry runs in every repo a host session opens; nothing starts a
 * daemon (which creates `.vtc/state/`) in a repo that never opted in.
 */
export const isVtcProject = (repoRoot: string): boolean => {
  try {
    return lstatSync(join(repoRoot, core.PROJECT_CONFIG_PATH)).isFile();
  } catch {
    return false;
  }
};

/** The repo is not set up for VTC (`vtc init` has not run there). */
export class NotInitialisedError extends Error {
  constructor(readonly repoRoot: string) {
    super(`VTC is not set up in ${repoRoot}: run \`vtc init\` there first`);
    this.name = "NotInitialisedError";
  }
}

/** Throws {@link NotInitialisedError} unless {@link isVtcProject}. */
export const requireVtcProject = (repoRoot: string): void => {
  if (!isVtcProject(repoRoot)) throw new NotInitialisedError(repoRoot);
};
