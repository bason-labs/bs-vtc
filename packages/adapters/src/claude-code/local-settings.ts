/**
 * Guards for the project's personal `.claude/settings.local.json`, which `install` writes in the
 * project scope. Every check runs before anything is written, so a refusal leaves every file as it
 * was.
 * - The file and its `.claude` directory must be real entries in the project, never links: a
 *   cloned repository could otherwise make install rewrite any JSON file the user owns.
 * - The file must stay out of git: a tracked one is refused (install would write machine paths
 *   into a shared, committed file); an untracked one nothing ignores yet is added to the repo's
 *   own `info/exclude`, which is local and never committed.
 * The session sandbox settings in that file, and the check that no settings layer reopens what it
 * closes, belong to the cli's confirmed `vtc install` flow (D-an), not to the adapter.
 */
import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { readTextOrNull } from "../common/files.js";

/** The local settings file, relative to the project root, as git names it. */
export const LOCAL_SETTINGS = ".claude/settings.local.json";

const isLink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** Refuses when `<projectRoot>/.claude` or the local settings file is a symlink. */
export const refuseLinkedLocalSettings = (projectRoot: string): void => {
  for (const path of [join(projectRoot, ".claude"), join(projectRoot, LOCAL_SETTINGS)]) {
    if (isLink(path)) {
      throw new Error(
        `refusing to edit ${join(projectRoot, LOCAL_SETTINGS)}: ${path} is a link, so the write could land outside the project; replace the link with a real file or directory, then install again`,
      );
    }
  }
};

/** Variables that would point git at another repository than the project's. */
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

interface GitResult {
  readonly status: number;
  readonly stdout: string;
}

/**
 * Runs a read-only git query in `repo`. `core.fsmonitor` is off, so the repository's own config
 * cannot start a command through it. Throws when git cannot run or fails (exit status above 1).
 */
const git = (repo: string, args: readonly string[]): GitResult => {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !GIT_LOCATION_VARS.includes(name)),
  );
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: repo,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
  if (result.error !== undefined || result.status === null || result.status > 1) {
    const reason =
      result.error?.message ?? (result.stderr.trim() || `exit ${String(result.status)}`);
    throw new Error(
      `refusing to edit ${join(repo, LOCAL_SETTINGS)}: git could not confirm it stays out of git (git ${args[0] ?? ""}: ${reason}); fix that, then install again`,
    );
  }
  return { status: result.status, stdout: result.stdout };
};

/** What keeping the local settings out of git takes: nothing, or one line added to a file. */
export type GitExclusion =
  | { readonly kind: "ignored" }
  | { readonly kind: "exclude"; readonly path: string; readonly text: string };

/** The line `info/exclude` gets: anchored to the repository root. */
const EXCLUDE_LINE = `/${LOCAL_SETTINGS}`;

/**
 * Checks the local settings file of the git checkout `repo`. Refuses a tracked file; for one
 * nothing ignores, returns the repository's `info/exclude` with the file's line appended.
 */
export const planGitExclusion = (repo: string): GitExclusion => {
  const tracked = git(repo, ["ls-files", "-z", "--", LOCAL_SETTINGS]).stdout;
  if (tracked !== "") {
    throw new Error(
      `refusing to edit ${join(repo, LOCAL_SETTINGS)}: it is tracked by git, and install would write paths on this machine into a shared file; untrack it (git rm --cached ${LOCAL_SETTINGS}), then install again`,
    );
  }
  if (git(repo, ["check-ignore", "-q", "--", LOCAL_SETTINGS]).status === 0) {
    return { kind: "ignored" };
  }
  const path = resolve(repo, git(repo, ["rev-parse", "--git-path", "info/exclude"]).stdout.trim());
  if (isLink(path)) {
    throw new Error(
      `refusing to edit ${path}: it is a link; replace it with a real file (or ignore ${LOCAL_SETTINGS} in .gitignore), then install again`,
    );
  }
  const current = readTextOrNull(path) ?? "";
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  return { kind: "exclude", path, text: `${current}${separator}${EXCLUDE_LINE}\n` };
};
