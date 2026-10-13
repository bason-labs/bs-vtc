/**
 * The engine's private directory for one repo: `<vtcHome>/guard/<repo-key>/` (0700, files
 * 0600). What the engine must be able to trust after a restart lives here, outside every path a
 * role can write (AD-7 rules 2 and 7; the repo and its worktrees are agent-writable): the ledger
 * of its own repo writes (`engine-writes.jsonl`, with a digest per event-log append), the record
 * of every dispatch (`dispatches/`, the git baseline and the engine files at dispatch), the git
 * baseline of every gate run still running (`gates/`), a held git change awaiting the human (`git-hold.json`), the runs the engine could not verify when
 * it opened (`held-runs.json`), and who claimed each run's Lead role (`leads.jsonl`).
 *
 * Residual: a role whose host sandbox lets it write the user's home directory could still reach
 * this directory; the host's per-path write deny (AD-8 rule 3) is what keeps roles to their
 * worktrees, and the engine's own checks never trust anything inside the repo.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
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
import { join } from "node:path";
import { engineRepoKey } from "@vtc/shared";

export const GUARD_DIR = "guard";

/** `<vtcHome>/guard/<repo-key>`. */
export const guardDirFor = (vtcHome: string, repoRoot: string): string =>
  join(vtcHome, GUARD_DIR, engineRepoKey(repoRoot));

/** Creates `abs` (and its parents) 0700; refuses a symlink in its place. */
export const ensurePrivateDir = (abs: string): void => {
  mkdirSync(abs, { recursive: true, mode: 0o700 });
  if (lstatSync(abs).isSymbolicLink()) throw new Error(`${abs} is a symlink`);
  chmodSync(abs, 0o700);
};

/** Replaces `abs` with `content` (0600; a fresh temp file renamed into place). */
export const writePrivateFile = (abs: string, content: string | Uint8Array): void => {
  const temp = `${abs}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    writeSync(fd, typeof content === "string" ? Buffer.from(content, "utf8") : content);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, abs);
};

/** The file's text, or `null` when it is missing, unreadable or not a regular file. */
export const readPrivateFile = (abs: string): string | null => {
  try {
    if (!lstatSync(abs).isFile()) return null;
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

export const removePrivateFile = (abs: string): void => {
  rmSync(abs, { force: true });
};

/** Appends `line` to `abs` (created 0600; never through a symlink). */
export const appendPrivateFile = (abs: string, line: string): void => {
  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
  const fd = openSync(
    abs,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow,
    0o600,
  );
  try {
    writeSync(fd, Buffer.from(line, "utf8"));
  } finally {
    closeSync(fd);
  }
};
