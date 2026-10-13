/**
 * Host config in engine worktrees (D-ao, spine §5 reading 72). A host started in a worktree loads
 * that worktree's project config: `.claude/**` (settings, hooks, agents), `.codex/**`
 * (`config.toml` with `[mcp_servers]` and `notify`) and `.mcp.json`. These run as host processes
 * outside any role sandbox, so a role that wrote one there would reach the next host start in the
 * same worktree (a fix round, a resume, a cross-family reviewer). Before every role dispatch or
 * resume, engine core compares them with the worktree's base commit and restores them: files
 * edited, added (tracked, untracked or ignored), deleted or replaced by a symlink all go back to
 * the base. Nothing is followed: a symlink is removed as a link, never through it.
 */
import {
  chmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";
import { runGit } from "./exec.js";
import { assertNoSymlinks, ensureRepoDir, writeRepoFile } from "./repo-files.js";
import { WORKTREES_DIR } from "./workspace.js";

/** The host config a worktree must keep at its base (two directories and one file). */
export const HOST_CONFIG_PATHS = [".claude", ".codex", ".mcp.json"] as const;

const SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

interface BaseEntry {
  readonly mode: string;
  readonly object: string;
}

/** The base commit's entries under the host config paths (`git ls-tree -r`), by path. */
const baseEntries = async (repoRoot: string, base: string): Promise<Map<string, BaseEntry>> => {
  const out = await runGit(repoRoot, [
    "ls-tree",
    "-r",
    "-z",
    "--full-tree",
    base,
    "--",
    ...HOST_CONFIG_PATHS,
  ]);
  const entries = new Map<string, BaseEntry>();
  for (const record of out.stdout.toString("utf8").split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [mode = "", type = "", object = ""] = record.slice(0, tab).split(" ");
    // a submodule (a commit entry) has no bytes to restore
    if (type !== "blob") continue;
    entries.set(record.slice(tab + 1), { mode, object });
  }
  return entries;
};

const blob = async (repoRoot: string, object: string): Promise<Buffer> =>
  (await runGit(repoRoot, ["cat-file", "blob", object])).stdout;

const statOf = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** Every non-directory under `rel` (lstat only; symlinks are leaves, never followed). */
const leavesUnder = (root: string, rel: string): string[] => {
  const stat = statOf(join(root, rel));
  if (stat === null) return [];
  if (!stat.isDirectory()) return [rel];
  return readdirSync(join(root, rel))
    .sort()
    .flatMap((name) => leavesUnder(root, `${rel}/${name}`));
};

const isExecutable = (mode: string): boolean => mode === "100755";

/** True when the worktree's `rel` is exactly the base entry (bytes, symlink target, exec bit). */
const matches = async (
  repoRoot: string,
  root: string,
  rel: string,
  entry: BaseEntry,
): Promise<boolean> => {
  const stat = statOf(join(root, rel));
  if (stat === null) return false;
  const want = await blob(repoRoot, entry.object);
  if (entry.mode === "120000") {
    return stat.isSymbolicLink() && readlinkSync(join(root, rel)) === want.toString("utf8");
  }
  if (!stat.isFile()) return false;
  if (isExecutable(entry.mode) !== ((stat.mode & 0o111) !== 0)) return false;
  return readFileSync(join(root, rel)).equals(want);
};

/** Removes `rel` (a file, a symlink as a link, or a directory) under `root`. */
const remove = (root: string, rel: string): void => {
  const parent = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : null;
  if (parent !== null) assertNoSymlinks(root, parent);
  rmSync(join(root, rel), { recursive: true, force: true });
};

/**
 * Restores the host config of the engine worktree `worktree` (repo-relative, under
 * `.vtc/state/worktrees/`) to commit `base`, and returns the paths (relative to the worktree)
 * that differed, sorted. An empty list means nothing was touched.
 */
export const restoreHostConfig = async (
  repoRoot: string,
  worktree: string,
  base: string,
): Promise<string[]> => {
  const id = worktree.startsWith(`${WORKTREES_DIR}/`)
    ? worktree.slice(WORKTREES_DIR.length + 1)
    : "";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id))
    throw new TypeError(`not an engine worktree: ${worktree}`);
  if (!SHA.test(base)) throw new TypeError(`expected a full git sha, got ${base}`);
  assertNoSymlinks(repoRoot, worktree);
  const root = join(repoRoot, worktree);
  const want = await baseEntries(repoRoot, base);
  const changed = new Set<string>();
  // whatever is there that the base does not have at that path: removed (a symlink as a link)
  for (const top of HOST_CONFIG_PATHS) {
    for (const leaf of leavesUnder(root, top)) {
      if (want.has(leaf)) continue;
      changed.add(leaf);
      remove(root, leaf);
    }
  }
  // the base's own entries, restored where they differ
  for (const [path, entry] of [...want].sort(([a], [b]) => a.localeCompare(b))) {
    if (await matches(repoRoot, root, path, entry)) continue;
    changed.add(path);
    const parts = path.split("/");
    // a symlink or a file where the base has a directory goes first
    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      const stat = statOf(join(root, dir));
      if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) remove(root, dir);
    }
    const target = statOf(join(root, path));
    if (target !== null && (target.isDirectory() || target.isSymbolicLink())) remove(root, path);
    const bytes = await blob(repoRoot, entry.object);
    if (entry.mode === "120000") {
      if (parts.length > 1) ensureRepoDir(root, parts.slice(0, -1).join("/"));
      rmSync(join(root, path), { force: true });
      symlinkSync(bytes.toString("utf8"), join(root, path));
      continue;
    }
    const mode = isExecutable(entry.mode) ? 0o755 : 0o644;
    writeRepoFile(root, path, bytes, mode);
    chmodSync(join(root, path), mode);
  }
  return [...changed].sort();
};
