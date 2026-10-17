/**
 * File helpers for Lookback: atomic writes through a temp file and a rename, whole-line JSONL
 * appends, and reads that treat a missing file as absent.
 */
import { randomBytes } from "node:crypto";
import { constants, readFileSync } from "node:fs";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** The file's UTF-8 text, or `undefined` when it does not exist. */
export const readTextIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** {@link readTextIfExists}, synchronously (the engine's prompt selector is synchronous). */
export const readTextIfExistsSync = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** `O_NOFOLLOW` where the platform has it (not on Windows, where the `lstat` check stands alone). */
const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
/** `O_NONBLOCK` where the platform has it: a FIFO swapped in after the `lstat` never blocks the open. */
const NON_BLOCK = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;

export type GuardedRead =
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly problem: string }
  | { readonly kind: "text"; readonly text: string };

/**
 * Reads a file a role can write, as UTF-8, only when it is a regular file (never through a
 * symbolic link, so a planted link cannot make the engine read another file of the user's) of at
 * most `maxBytes`. The open never blocks (a FIFO swapped in after the check is refused), and at most
 * `maxBytes + 1` bytes are read, so a file that grows after the size check is refused too.
 */
export const readRoleWrittenText = async (path: string, maxBytes: number): Promise<GuardedRead> => {
  const tooLarge = (): GuardedRead => ({
    kind: "refused",
    problem: `${path} is larger than ${String(maxBytes)} bytes`,
  });
  try {
    const info = await lstat(path);
    if (!info.isFile()) return { kind: "refused", problem: `${path} is not a regular file` };
    const handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    try {
      const opened = await handle.stat();
      if (!opened.isFile()) return { kind: "refused", problem: `${path} is not a regular file` };
      if (opened.size > maxBytes) return tooLarge();
      const buffer = new Uint8Array(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maxBytes) return tooLarge();
      return { kind: "text", text: Buffer.from(buffer.buffer, 0, length).toString("utf8") };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    if ((error as { code?: unknown }).code === "ELOOP")
      return { kind: "refused", problem: `${path} is not a regular file` };
    throw error;
  }
};

/**
 * Writes a new file through a sibling temp file published with a hard link, which never replaces
 * an existing file: returns `false` (and changes nothing) when `path` already exists.
 */
export const writeNewFile = async (path: string, data: string): Promise<boolean> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, data, { flag: "wx" });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as { code?: unknown }).code === "EEXIST") return false;
    throw error;
  } finally {
    await rm(temp, { force: true });
  }
};

/** Writes the file through a sibling temp file and a rename. */
export const writeAtomic = async (path: string, data: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
};

/**
 * {@link writeAtomic} for a repo-tracked Lookback output at `relPath` under `projectRoot`: each
 * directory between the root and the file is created if missing and must otherwise be a real
 * directory, never a symbolic link (a repo that commits one there would send the write, and its
 * temp file, outside the repo); the rename replaces a link at the file itself without writing
 * through it. Throws, writing nothing, when a directory on the way is a link or not a directory.
 */
export const writeRepoFileAtomic = async (
  projectRoot: string,
  relPath: string,
  data: string,
): Promise<void> => {
  await writeAtomic(await repoFilePath(projectRoot, relPath), data);
};

/**
 * The absolute path of the repo-tracked Lookback file at `relPath`, once every directory between
 * `projectRoot` and it exists as a real directory of the repo: each is created if missing and must
 * otherwise be a directory, never a symbolic link. Throws when one is not.
 */
const repoFilePath = async (projectRoot: string, relPath: string): Promise<string> => {
  const parts = relPath.split(/[\\/]/).filter((p) => p !== "" && p !== ".");
  if (parts.length === 0 || parts.includes(".."))
    throw new Error(`${relPath} is not a path inside the repo`);
  await mkdir(projectRoot, { recursive: true });
  let dir = projectRoot;
  for (const part of parts.slice(0, -1)) {
    dir = join(dir, part);
    let info;
    try {
      info = await lstat(dir);
    } catch (error) {
      if (!isMissing(error)) throw error;
      // one level at a time: a link planted there meanwhile makes this mkdir fail (EEXIST)
      await mkdir(dir);
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`${dir} is not a directory of the repo (a symbolic link or a file)`);
  }
  return join(projectRoot, ...parts);
};

/**
 * {@link appendJsonLines} for a repo-tracked Lookback log at `relPath` under `projectRoot` (spine
 * §5 reading 249): the directories on the way as {@link writeRepoFileAtomic} checks them, and the
 * file opened for appending without following a link (`O_NOFOLLOW`, never blocking on a FIFO) and
 * checked to be a regular file before anything is written, so a repo that commits a link there
 * (to a user's shell profile, say) never has engine lines appended outside the repo. Throws,
 * writing nothing, when the file or a directory on the way is not the repo's own.
 */
export const appendRepoJsonLines = async (
  projectRoot: string,
  relPath: string,
  values: readonly unknown[],
): Promise<void> => {
  if (values.length === 0) return;
  const path = await repoFilePath(projectRoot, relPath);
  const refused = (): Error => new Error(`${path} is not a regular file of the repo`);
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW | NON_BLOCK,
      0o644,
    );
  } catch (error) {
    if ((error as { code?: unknown }).code === "ELOOP") throw refused();
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw refused();
    // a link where the platform has no O_NOFOLLOW: the lstat stands alone
    if ((await lstat(path)).isSymbolicLink()) throw refused();
    await handle.write(values.map((v) => `${JSON.stringify(v)}\n`).join(""));
  } finally {
    await handle.close();
  }
};

/**
 * Like {@link writeAtomic}, but replaces the file only when it still holds `expected` (`undefined`:
 * still absent) just before the rename; otherwise nothing changes and it returns `false`. This
 * narrows a lost update to the instant between that check and the rename.
 */
export const writeAtomicIfUnchanged = async (
  path: string,
  data: string,
  expected: string | undefined,
): Promise<boolean> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, data);
  if ((await readTextIfExists(path)) !== expected) {
    await rm(temp, { force: true });
    return false;
  }
  await rename(temp, path);
  return true;
};

/** Appends whole JSON lines. `mode` applies when the append creates the file. */
export const appendJsonLines = async (
  path: string,
  values: readonly unknown[],
  options: { readonly mode?: number } = {},
): Promise<void> => {
  if (values.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(
    path,
    values.map((v) => `${JSON.stringify(v)}\n`).join(""),
    options.mode === undefined ? {} : { mode: options.mode },
  );
};

/** The JSON values of a JSONL file (lines that do not parse are skipped). */
export const readJsonLines = async (path: string): Promise<unknown[]> => {
  const text = await readTextIfExists(path);
  if (text === undefined) return [];
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // A torn or hand-edited line: skipped, the rest still counts.
    }
  }
  return values;
};

const mtimeOrNull = async (path: string): Promise<number | null> => {
  try {
    return (await lstat(path)).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * Takes a stale lock over without removing a fresh one (the protocol of `LOOKBACK_HOME.pinsLock`,
 * spine §5 reading 128): the lock is renamed to a name only this call uses, and if what was renamed
 * turns out fresh (another taker replaced the stale lock meanwhile) it is linked back into place
 * (`link` never overwrites a newer lock).
 */
const breakStaleLock = async (lock: string, staleMs: number): Promise<void> => {
  const mtime = await mtimeOrNull(lock);
  if (mtime === null || Date.now() - mtime <= staleMs) return;
  const moved = `${lock}.${randomBytes(6).toString("hex")}.stale`;
  try {
    await rename(lock, moved);
  } catch {
    return; // removed or taken over meanwhile
  }
  const movedTime = await mtimeOrNull(moved);
  if (movedTime !== null && Date.now() - movedTime <= staleMs) {
    try {
      await link(moved, lock);
    } catch {
      // a newer lock is already in place
    }
  }
  await rm(moved, { force: true });
};

/**
 * Runs `fn` holding `lock`: created exclusively (`wx`) holding a token only this call knows, a lock
 * older than `staleMs` taken over ({@link breakStaleLock}), released only while it still holds the
 * token. Returns `undefined` without running `fn` when the lock stays held for `waitMs`.
 *
 * Mutual exclusion holds only while every holder finishes well within `staleMs`: a holder still
 * running past it can be taken over, and a takeover that races its release or another takeover
 * can leave two holders. So a holder keeps the lock around its read-modify-write only, never
 * across a wait on a person (the cli's gestures confirm first and lock after); writers also
 * replace the file only if it is unchanged ({@link writeAtomicIfUnchanged}).
 */
export const withFileLock = async <T>(
  lock: string,
  options: { readonly staleMs: number; readonly waitMs: number },
  fn: () => Promise<T>,
): Promise<{ readonly value: T } | undefined> => {
  await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
  const token = `${String(process.pid)}.${randomBytes(8).toString("hex")}`;
  const deadline = Date.now() + options.waitMs;
  for (;;) {
    try {
      await writeFile(lock, token, { flag: "wx", mode: 0o600 });
      break;
    } catch (error) {
      if ((error as { code?: unknown }).code !== "EEXIST") throw error;
      await breakStaleLock(lock, options.staleMs);
      if (Date.now() > deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return { value: await fn() };
  } finally {
    // Only our own lock: a stale-lock takeover may have replaced it.
    if ((await readTextIfExists(lock).catch(() => undefined)) === token)
      await rm(lock, { force: true });
  }
};
