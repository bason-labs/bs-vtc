/**
 * The engine's record of AI tiebreak answers (`LOOKBACK_HOME.tiebreaksFile`, spine §5 readings 137
 * and 175): one `LookbackTiebreakRecord` per line under the VTC home, never in a repo. An
 * `ai_tiebreak` row of the git-tracked `attributions.jsonl` counts only when its
 * `lookbackTiebreakKey` is recorded here ({@link readTiebreakKeys} feeds `trustedAttributions`).
 *
 * Only the engine writes it, through {@link appendTiebreakRecord}, which the daemon hands to core
 * (core never imports lookback, AD-13 rule 12): one whole line per answer with `O_APPEND` (never a
 * rewrite), the file created with mode `0600`, and a symbolic link at the file or its directory
 * refused. Readers parse each line with `parsePersisted` and skip one that does not parse.
 */
import {
  LOOKBACK_HOME,
  LookbackTiebreakRecordSchema,
  parsePersisted,
  RepoKeySchema,
  type LookbackTiebreakRecord,
} from "@vtc/shared";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Absolute path of the tiebreak store under the VTC home. */
export const tiebreaksPath = (vtcHome: string): string =>
  join(vtcHome, LOOKBACK_HOME.tiebreaksFile);

/** `O_NOFOLLOW` where the platform has it (not on Windows, where the `lstat` checks stand alone). */
const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;

const code = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

/** Refuses a directory that is a symbolic link or not a directory. */
const checkDir = async (dir: string): Promise<void> => {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`refusing to write the tiebreak store: ${dir} is not a plain directory`);
};

/**
 * Appends one AI tiebreak answer (validated against `LookbackTiebreakRecordSchema`) to the store.
 * Throws, writing nothing, when the record is invalid or the file or its directory is a symbolic
 * link (or not a regular file / directory).
 */
export const appendTiebreakRecord = async (
  vtcHome: string,
  record: LookbackTiebreakRecord,
): Promise<void> => {
  const line = `${JSON.stringify(LookbackTiebreakRecordSchema.parse(record))}\n`;
  const path = tiebreaksPath(vtcHome);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkDir(dir);
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new Error(`refusing to write the tiebreak store: ${path} is a symbolic link`);
  } catch (error) {
    if (code(error) !== "ENOENT") throw error;
  }
  let handle;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | NO_FOLLOW | NON_BLOCK,
      0o600,
    );
  } catch (error) {
    if (code(error) === "ELOOP")
      throw new Error(`refusing to write the tiebreak store: ${path} is a symbolic link`, {
        cause: error,
      });
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile())
      throw new Error(`refusing to write the tiebreak store: ${path} is not a regular file`);
    // one write of one whole line: O_APPEND keeps concurrent appends from interleaving
    await handle.write(line);
  } finally {
    await handle.close();
  }
};

/**
 * The `tiebreak_key`s the engine recorded for one project (`repo_key`, an `engineRepoKey`): the
 * set `trustedAttributions` checks `ai_tiebreak` rows against. A missing store is empty; a store
 * that is a symbolic link or not a regular file counts as empty too (fail closed), and a line that
 * does not parse is skipped.
 */
export const readTiebreakKeys = async (vtcHome: string, repoKey: string): Promise<Set<string>> => {
  const keys = new Set<string>();
  if (!RepoKeySchema.safeParse(repoKey).success) return keys;
  const path = tiebreaksPath(vtcHome);
  let text: string;
  try {
    const dir = await lstat(dirname(path));
    if (dir.isSymbolicLink() || !dir.isDirectory()) return keys;
    const info = await lstat(path);
    if (!info.isFile()) return keys;
    const handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NON_BLOCK);
    try {
      if (!(await handle.stat()).isFile()) return keys;
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (code(error) === "ENOENT" || code(error) === "ELOOP") return keys;
    throw error;
  }
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const parsed = parsePersisted(LookbackTiebreakRecordSchema, value);
    if (parsed.success && parsed.data.repo_key === repoKey) keys.add(parsed.data.tiebreak_key);
  }
  return keys;
};
