/** File helpers for `install`: atomic writes, careful edits of the user's own config files. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./json.js";

const tempSibling = (path: string): string =>
  join(dirname(path), `.${randomBytes(6).toString("hex")}.vtc-tmp`);

/** Mode of a file `writeFileAtomic` creates: the user's config files often hold MCP `env` tokens. */
const NEW_FILE_MODE = 0o600;

/**
 * The file a write to `path` must replace: `path` itself, or the file an existing symlink points
 * at (a dotfile manager's link stays a link). Refuses a dangling link rather than replacing it.
 */
const writeTarget = (path: string): string => {
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return path;
  }
  if (!isLink) return path;
  try {
    return realpathSync(path);
  } catch {
    throw new Error(`${path} is a link to a missing file; fix or remove it, then install again`);
  }
};

/**
 * Writes `text` to `path` through a temp file and a rename, so a reader never sees half a file.
 * The new file keeps the mode of the file it replaces (0600 when there was none), and a symlinked
 * `path` has its target rewritten, never the link. The temp file is created exclusively, so a
 * planted file or link at its name is never followed.
 */
export const writeFileAtomic = (path: string, text: string): void => {
  const target = writeTarget(path);
  mkdirSync(dirname(target), { recursive: true });
  let mode = NEW_FILE_MODE;
  try {
    mode = statSync(target).mode & 0o7777;
  } catch {
    // a new file
  }
  const temp = tempSibling(target);
  try {
    writeFileSync(temp, text, { encoding: "utf8", mode, flag: "wx" });
    // the umask may have narrowed the mode it was created with
    chmodSync(temp, mode);
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

export const readTextOrNull = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

/**
 * A JSON settings file as an object: `{}` when it does not exist. Throws when it exists but is
 * not a JSON object, so `install` never overwrites a file it cannot read back.
 */
export const readJsonSettings = (path: string): Record<string, unknown> => {
  const raw = readTextOrNull(path);
  if (raw === null || raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it, then install again`);
  }
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object; refusing to edit it`);
  return value;
};

export const writeJson = (path: string, value: unknown): void => {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Replaces the directory `target` with a copy of `source`: copied next to it first, then swapped
 * in, so a failed copy leaves the previous install in place.
 */
export const replaceDirectory = (source: string, target: string): void => {
  mkdirSync(dirname(target), { recursive: true });
  const staging = tempSibling(target);
  const previous = tempSibling(target);
  try {
    cpSync(source, staging, { recursive: true, dereference: true });
    const hadTarget = existsSync(target);
    if (hadTarget) renameSync(target, previous);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (hadTarget) renameSync(previous, target);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
  }
};

/**
 * Creates `dir` (mode 0700) if needed and checks it is a private directory of this user: a real
 * directory, not a link, owned by this user and closed to group and others. Throws otherwise, so
 * a directory another local user planted in a shared temp directory is never written into.
 */
export const ensurePrivateDir = (dir: string): void => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  const uid = process.getuid?.();
  const posix = process.platform !== "win32";
  if (
    !stat.isDirectory() ||
    (uid !== undefined && stat.uid !== uid) ||
    (posix && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error(
      `${dir} is not a private directory of this user (it must be a directory you own with mode 0700); remove it and try again`,
    );
  }
};
