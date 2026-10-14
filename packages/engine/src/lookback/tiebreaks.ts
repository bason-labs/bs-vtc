/**
 * The engine's record of AI tiebreak answers (`LOOKBACK_HOME.tiebreaksFile`, spine §5 readings 137
 * and 175): one `LookbackTiebreakRecord` per line under the VTC home, never in a repo. An
 * `ai_tiebreak` row of the git-tracked `attributions.jsonl` counts only when its
 * `lookbackTiebreakKey` is recorded here ({@link readTiebreakKeys} feeds `trustedAttributions`).
 *
 * Only the engine writes it, through {@link appendTiebreakRecord}, which the daemon hands to core
 * (core never imports lookback, AD-13 rule 12). The writer takes the `ai_tiebreak` attribution row
 * the answer backs and keys the record itself with `lookbackTiebreakKey`, so a stored key cannot
 * disagree with its row: one whole line per answer with `O_APPEND` (never a rewrite), the file
 * created with (or tightened to) mode `0600`, and a symbolic link at the file or its directory
 * refused, checked again after the file is open. Readers parse each line with `parsePersisted`
 * and skip one that does not parse.
 */
import {
  AttributionSchema,
  LOOKBACK_HOME,
  lookbackTiebreakKey,
  LookbackTiebreakRecordSchema,
  parsePersisted,
  RepoKeySchema,
  type Attribution,
  type LookbackTiebreakRecord,
} from "@vtc/shared";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Absolute path of the tiebreak store under the VTC home. */
export const tiebreaksPath = (vtcHome: string): string =>
  join(vtcHome, LOOKBACK_HOME.tiebreaksFile);

/**
 * The most bytes {@link readTiebreakKeys} reads (about 60 000 answers). A larger store is not read
 * and no tiebreak counts (fail closed).
 */
export const TIEBREAK_STORE_MAX_BYTES = 16 * 1024 * 1024;

/** `O_NOFOLLOW` where the platform has it (not on Windows, where the `lstat` checks stand alone). */
const NO_FOLLOW = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
const NON_BLOCK = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
const POSIX = process.platform !== "win32";

const code = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const sameFile = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino;

/** Refuses a directory that is a symbolic link or not a directory; returns what it checked. */
const checkDir = async (dir: string): Promise<Stats> => {
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error(`refusing to write the tiebreak store: ${dir} is not a plain directory`);
  return info;
};

/** One AI tiebreak answer to record: the `ai_tiebreak` row it backs, in which project, and when. */
export interface TiebreakAnswer {
  /** The `ai_tiebreak` {@link Attribution} row the answer backs. */
  readonly attribution: Attribution;
  /** The project's `engineRepoKey`. */
  readonly repo_key: string;
  /** When the engine recorded it (ISO date-time). */
  readonly recorded_at: string;
}

/** Pure: the record of an answer, keyed with `lookbackTiebreakKey` of its attribution row. */
export const tiebreakRecordFor = (answer: TiebreakAnswer): LookbackTiebreakRecord => {
  const attribution = AttributionSchema.parse(answer.attribution);
  if (attribution.method !== "ai_tiebreak")
    throw new Error(
      `a tiebreak record backs an ai_tiebreak attribution, not a ${attribution.method} one`,
    );
  return LookbackTiebreakRecordSchema.parse({
    v: 1,
    tiebreak_key: lookbackTiebreakKey(attribution),
    repo_key: answer.repo_key,
    run: attribution.run,
    trace: attribution.trace,
    blamed_role: attribution.blamed_role,
    recorded_at: answer.recorded_at,
  });
};

/**
 * Records one AI tiebreak answer: derives the record from its `ai_tiebreak` attribution row
 * ({@link tiebreakRecordFor}) and appends it to the store. Throws, writing nothing, when the
 * answer is invalid or the file or its directory is a symbolic link (or not a regular file /
 * directory), or either was swapped while the file was opened. Returns the record written.
 */
export const appendTiebreakRecord = async (
  vtcHome: string,
  answer: TiebreakAnswer,
): Promise<LookbackTiebreakRecord> => {
  const record = tiebreakRecordFor(answer);
  const line = `${JSON.stringify(record)}\n`;
  const path = tiebreaksPath(vtcHome);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const dirBefore = await checkDir(dir);
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
    const opened = await handle.stat();
    if (!opened.isFile())
      throw new Error(`refusing to write the tiebreak store: ${path} is not a regular file`);
    // O_NOFOLLOW guards the last component only: the directory, and the file at the path, must
    // still be the ones checked and opened (no link swapped in between)
    const dirAfter = await checkDir(dir);
    const atPath = await lstat(path);
    if (!sameFile(dirBefore, dirAfter) || atPath.isSymbolicLink() || !sameFile(opened, atPath))
      throw new Error(`refusing to write the tiebreak store: ${path} changed while it was opened`);
    if (POSIX && (opened.mode & 0o077) !== 0) await handle.chmod(0o600);
    // one write of one whole line: O_APPEND keeps concurrent appends from interleaving
    await handle.write(line);
  } finally {
    await handle.close();
  }
  return record;
};

/**
 * The `tiebreak_key`s the engine recorded for one project (`repo_key`, an `engineRepoKey`): the
 * set `trustedAttributions` checks `ai_tiebreak` rows against. A missing store is empty; a store
 * that is a symbolic link, not a regular file, swapped while it was opened, or over
 * {@link TIEBREAK_STORE_MAX_BYTES} counts as empty too (fail closed), and a line that does not
 * parse is skipped.
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
      const opened = await handle.stat();
      if (!opened.isFile() || !sameFile(info, opened)) return keys;
      const dirAfter = await lstat(dirname(path));
      if (!sameFile(dir, dirAfter)) return keys;
      if (opened.size > TIEBREAK_STORE_MAX_BYTES) return keys;
      // read at most the cap (+1 to see a store that grew past it since the stat)
      const buffer = Buffer.alloc(Math.min(opened.size, TIEBREAK_STORE_MAX_BYTES) + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > TIEBREAK_STORE_MAX_BYTES) return keys;
      text = buffer.subarray(0, length).toString("utf8");
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
