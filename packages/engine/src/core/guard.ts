/**
 * The engine's private directory for one repo: `<vtcHome>/guard/<repo-key>/` (0700, files
 * 0600). What the engine must be able to trust after a restart lives here, outside every path a
 * role can write (AD-7 rules 2 and 7; the repo and its worktrees are agent-writable): the ledger
 * of its own repo writes (`engine-writes.jsonl`, with a digest per event-log append), the record
 * of every dispatch (`dispatches/`, the git baseline and the engine files at dispatch), the git
 * baseline of every gate run still running (`gates/`), a held git change awaiting the human (`git-hold.json`), the runs the engine could not verify when
 * it opened (`held-runs.json`), who claimed each run's Lead role (`leads.jsonl`), and the human's
 * repo-level automation kill switch (`automation-paused.json`, {@link AUTOMATION_PAUSED_FILE}).
 *
 * No role may write here: `ROLE_DENIED_VTC.homeWriteDeny` names `guard/**` (contracts 4.12.0), so
 * every Claude role profile and the Lead session deny it to the file tools and the sandbox, and a
 * Codex role writes only its worktree and the temp roots. What is read back is still checked
 * against its shape (the replay plan and trial rows, `replay.ts`), and the engine's own checks
 * never trust anything inside the repo.
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

/**
 * `vtc pause` as the kill switch of automation for the whole repo (spec §15; AD-27 rule 7 "`vtc
 * pause` stops everything"): set by every `pause`, run or no run, cleared only by the human's
 * `vtc resume`. Automatic issues, PRs and the sweep stop while it is set, so an idle daemon
 * (between runs, after a cancel or a finished run) can still be stopped. It lives here, where no
 * role can write.
 */
export const AUTOMATION_PAUSED_FILE = "automation-paused.json";

/** Whether the human's automation kill switch is set for this repo. */
export const automationPausedByHuman = (guardDir: string): boolean =>
  readPrivateFile(join(guardDir, AUTOMATION_PAUSED_FILE)) !== null;

/** Sets (`at`) or clears (`null`) the automation kill switch; returns whether it was set before. */
export const setAutomationPaused = (guardDir: string, at: string | null): boolean => {
  const was = automationPausedByHuman(guardDir);
  const file = join(guardDir, AUTOMATION_PAUSED_FILE);
  if (at === null) {
    removePrivateFile(file);
    return was;
  }
  ensurePrivateDir(guardDir);
  writePrivateFile(file, `${JSON.stringify({ at })}\n`);
  return was;
};
