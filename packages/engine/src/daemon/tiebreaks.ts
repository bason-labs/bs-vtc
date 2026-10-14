/**
 * The engine's record of AI tiebreak answers (`LOOKBACK_HOME.tiebreaksFile`, spine §5 readings 137
 * and 175): one `LookbackTiebreakRecord` per line under the VTC home, where no role may write
 * (`ROLE_DENIED_VTC`). An `ai_tiebreak` row of the git-tracked `attributions.jsonl` counts only when
 * its `lookbackTiebreakKey` is here. The daemon owns this seam (core never imports lookback, AD-13
 * rule 12): it hands the keys to `lookbackAtRunEnd` and records every `ai_tiebreak` row the engine
 * itself produces. Writer rules (4.10.0): append only (`O_APPEND`, never a rewrite), created `0600`,
 * never through a symlink at the path or its directory. Readers skip a line that does not parse.
 */
import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  LOOKBACK_HOME,
  lookbackTiebreakKey,
  LookbackTiebreakRecordSchema,
  parsePersisted,
  type Attribution,
} from "@vtc/shared";

/** Absolute path of the tiebreak store. */
export const tiebreaksPath = (vtcHome: string): string =>
  join(vtcHome, LOOKBACK_HOME.tiebreaksFile);

const refuseSymlink = (path: string): void => {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) throw new Error(`${path} is a symlink: the tiebreak store refuses it`);
};

/** The tiebreak keys the engine recorded for this project (`engineRepoKey`). */
export const readTiebreakKeys = (vtcHome: string, repoKey: string): ReadonlySet<string> => {
  const path = tiebreaksPath(vtcHome);
  let text: string;
  try {
    refuseSymlink(dirname(path));
    refuseSymlink(path);
    text = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = parsePersisted(LookbackTiebreakRecordSchema, value);
    if (parsed.success && parsed.data.repo_key === repoKey) keys.add(parsed.data.tiebreak_key);
  }
  return keys;
};

/**
 * Records the engine's own `ai_tiebreak` attribution row: its key, run, dispatch and blame. Throws
 * for a row of another method, or a store that is (or sits under) a symlink.
 */
export const recordTiebreak = (
  vtcHome: string,
  repoKey: string,
  row: Attribution,
  now: Date,
): void => {
  if (row.method !== "ai_tiebreak") throw new TypeError(`not an ai_tiebreak row: ${row.method}`);
  const record = LookbackTiebreakRecordSchema.parse({
    v: 1,
    tiebreak_key: lookbackTiebreakKey(row),
    repo_key: repoKey,
    run: row.run,
    trace: row.trace,
    blamed_role: row.blamed_role,
    recorded_at: now.toISOString(),
  });
  const path = tiebreaksPath(vtcHome);
  const dir = dirname(path);
  refuseSymlink(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  refuseSymlink(dir);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, `${JSON.stringify(record)}\n`);
  } finally {
    closeSync(fd);
  }
};
