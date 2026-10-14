/**
 * No-follow file writes for the upstream module's state (the ledger, evidence manifests, locks and
 * the pacing log). Some of it lives inside a project checkout (`.vtc/state/automation/`,
 * `.vtc/evidence/auto/`), where a role or a merged role branch could plant a symlink; the engine
 * runs unsandboxed, so it never writes through one: every directory below the trusted root is
 * checked segment by segment, new files are opened with `O_NOFOLLOW` (and `O_EXCL` where they must
 * be new), and whole-file writes go to a fresh temporary file renamed into place.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";

/** `O_NOFOLLOW` where the platform has it (macOS, Linux; Windows has none). */
const NOFOLLOW: number = (constants as Partial<typeof constants>).O_NOFOLLOW ?? 0;

const code = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;

/** Refusal of a symlinked path; the message never holds the path (it may name the project). */
export class SymlinkRefused extends Error {
  constructor(what: string) {
    super(`refusing to write ${what} through a symlink or a non-directory`);
    this.name = "SymlinkRefused";
  }
}

/**
 * Creates `dir` below the trusted `root` one segment at a time (mode 0700) and refuses any segment
 * that is a symlink or not a directory. `root` itself is trusted (VTC's home or the project root).
 */
export const ensureDirNoFollow = (root: string, dir: string, what = "VTC state"): string => {
  const rel = relative(root, dir);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${what} is outside its root`);
  let current = root;
  for (const segment of rel === "" ? [] : rel.split(sep)) {
    current = join(current, segment);
    try {
      mkdirSync(current, { mode: 0o700 });
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new SymlinkRefused(what);
  }
  return current;
};

/**
 * Writes `text` to `dir/name` through a fresh `O_CREAT|O_EXCL|O_NOFOLLOW` temporary file renamed
 * into place (a planted `name` symlink is replaced, never followed).
 */
export const writeFileNoFollow = (dir: string, name: string, text: string, mode = 0o600): void => {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
    mode,
  );
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, join(dir, name));
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
};

/** Appends `text` to `path`, created 0600 if missing, never through a symlink. */
export const appendNoFollow = (path: string, text: string, what = "VTC state"): void => {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (code(error) === "ELOOP") throw new SymlinkRefused(what);
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
};

/** The text of `path`, or `null` when it does not exist; never through a symlink. */
export const readNoFollow = (path: string, what = "VTC state"): string | null => {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (code(error) === "ENOENT") return null;
    if (code(error) === "ELOOP") throw new SymlinkRefused(what);
    throw error;
  }
  try {
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

/** Creates `path` exclusively (`O_EXCL|O_NOFOLLOW`) with `text`; false when it already exists. */
export const createExclusive = (path: string, text: string): boolean => {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (code(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  return true;
};

/** A file name made from a repo (`owner/name` → `owner__name`). */
export const repoFileName = (repo: string): string =>
  basename(repo.replace(/\//g, "__").replace(/[^A-Za-z0-9_.-]/g, "_"));
