/**
 * Engine writes inside the repo that never follow a symlink. Agents write in the repo (phase
 * roles in the checkout, Designers under `.vtc/design/`), so any path the engine writes to may
 * have been replaced by a symlink pointing outside the repo. Every component below the repo root
 * is checked with `lstat`; files are written to a temp file and renamed into place (a rename
 * replaces a symlink, never its target); appends open with `O_NOFOLLOW`.
 *
 * Every write is reported to the root's {@link RepoWriteObserver}, if one is registered: engine
 * core keeps a ledger of what the engine wrote, so a later change to those files by anyone else
 * is detected (AD-7 rule 7).
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

export class UnsafePathError extends Error {
  constructor(
    readonly path: string,
    detail: string,
  ) {
    super(`refusing to write ${path}: ${detail}`);
    this.name = "UnsafePathError";
  }
}

/** What an engine write did to a repo file. */
export type RepoWrite =
  | { readonly kind: "write"; readonly rel: string; readonly content: Uint8Array }
  | { readonly kind: "remove"; readonly rel: string }
  | {
      readonly kind: "append";
      readonly rel: string;
      /** The file's size right before the append. */
      readonly sizeBefore: number;
      readonly content: Uint8Array;
    };

export type RepoWriteObserver = (write: RepoWrite) => void;

const observers = new Map<string, RepoWriteObserver>();

/** Registers the observer of every write under `root` (one per root); returns the removal. */
export const observeRepoWrites = (root: string, observer: RepoWriteObserver): (() => void) => {
  observers.set(root, observer);
  return () => {
    if (observers.get(root) === observer) observers.delete(root);
  };
};

const bytesOf = (content: string | Uint8Array): Uint8Array =>
  typeof content === "string" ? Buffer.from(content, "utf8") : content;

const segmentsOf = (rel: string): string[] => {
  const parts = rel.split("/");
  if (
    rel === "" ||
    rel.startsWith("/") ||
    rel.includes("\\") ||
    rel.includes("\0") ||
    parts.some((p) => p === "" || p === "." || p === "..")
  ) {
    throw new UnsafePathError(rel, "not a plain repo-relative path");
  }
  return parts;
};

const kindOf = (abs: string): "missing" | "dir" | "file" | "symlink" | "other" => {
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return "symlink";
    if (stat.isDirectory()) return "dir";
    return stat.isFile() ? "file" : "other";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
};

/**
 * Throws when any existing component of `rel` below `root` is a symlink (or a parent is not a
 * directory). Missing components are fine.
 */
export const assertNoSymlinks = (root: string, rel: string): void => {
  const parts = segmentsOf(rel);
  let current = root;
  for (const [i, part] of parts.entries()) {
    current = join(current, part);
    const kind = kindOf(current);
    if (kind === "missing") return;
    if (kind === "symlink")
      throw new UnsafePathError(rel, `${parts.slice(0, i + 1).join("/")} is a symlink`);
    if (i < parts.length - 1 && kind !== "dir")
      throw new UnsafePathError(rel, `${parts.slice(0, i + 1).join("/")} is not a directory`);
  }
};

/** Creates `relDir` under `root` one component at a time, refusing symlinks on the way. */
export const ensureRepoDir = (root: string, relDir: string): void => {
  let current = root;
  for (const part of segmentsOf(relDir)) {
    current = join(current, part);
    const kind = kindOf(current);
    if (kind === "missing") {
      try {
        mkdirSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (kindOf(current) !== "dir")
        throw new UnsafePathError(relDir, `${current} is not a directory`);
    } else if (kind !== "dir") {
      throw new UnsafePathError(relDir, `${current} is a ${kind}, not a directory`);
    }
  }
};

const parentOf = (rel: string): string | null => {
  const dir = dirname(rel);
  return dir === "." ? null : dir;
};

export interface WriteRepoFileOptions {
  /**
   * Give the file exactly `mode`, whatever the umask: set on the temp file's own descriptor
   * before the rename, so nothing is changed by path once the file is in place (a path a
   * concurrent writer could have swapped for a symlink). Default `false`: the umask applies.
   */
  readonly exactMode?: boolean;
}

/** Replaces `rel` under `root` with `content` (temp file + rename; never through a symlink). */
export const writeRepoFile = (
  root: string,
  rel: string,
  content: string | Uint8Array,
  mode = 0o644,
  options: WriteRepoFileOptions = {},
): void => {
  segmentsOf(rel);
  const parent = parentOf(rel);
  if (parent !== null) ensureRepoDir(root, parent);
  const target = join(root, rel);
  if (kindOf(target) === "dir") throw new UnsafePathError(rel, "is a directory");
  const temp = `${target}.vtc-${randomBytes(6).toString("hex")}.tmp`;
  const bytes = bytesOf(content);
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  try {
    const fd = openSync(
      temp,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow,
      mode,
    );
    try {
      writeFileSync(fd, bytes);
      if (options.exactMode === true) fchmodSync(fd, mode);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  observers.get(root)?.({ kind: "write", rel, content: bytes });
};

/** Appends to `rel` under `root`, creating it; refuses a symlink at any component. */
export const appendRepoFile = (root: string, rel: string, content: string): void => {
  segmentsOf(rel);
  const parent = parentOf(rel);
  if (parent !== null) ensureRepoDir(root, parent);
  const target = join(root, rel);
  const kind = kindOf(target);
  if (kind !== "missing" && kind !== "file") throw new UnsafePathError(rel, `is a ${kind}`);
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(
    target,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
    0o644,
  );
  const bytes = bytesOf(content);
  let sizeBefore: number;
  try {
    sizeBefore = fstatSync(fd).size;
    writeSync(fd, bytes);
  } finally {
    closeSync(fd);
  }
  observers.get(root)?.({ kind: "append", rel, sizeBefore, content: bytes });
};

/** Removes `rel` under `root` if it exists (never through a symlinked parent). */
export const removeRepoFile = (root: string, rel: string): void => {
  segmentsOf(rel);
  const parent = parentOf(rel);
  if (parent !== null) assertNoSymlinks(root, parent);
  rmSync(join(root, rel), { force: true });
  observers.get(root)?.({ kind: "remove", rel });
};
