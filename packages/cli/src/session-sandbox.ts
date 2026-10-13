/**
 * The Claude Code session sandbox of a repo (D-an, spine §5 reading 71). In plugin-only dispatch
 * (AD-17) a code-running role is a subagent of the human's Lead session, so its shell is confined
 * only by that session's own sandbox. The settings live in the project's gitignored
 * `.claude/settings.local.json` (`claudeSessionSandboxSettings`):
 * - the bridge reports their state in its hello (`claudeSessionSandboxState`, `bridge.ts`);
 * - `vtc install --host claude-code` shows them, merges them in after the user confirms (keeping
 *   the user's other keys) and makes sure git ignores the file;
 * - `vtc doctor` reports the state and what is missing.
 * A cloned repo can commit `.claude` or the file as a symlink pointing anywhere, so neither is
 * ever followed: such a file reads as `unreadable` (state `unknown`) and is never written through.
 */
import {
  appendFileSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  claudeSessionSandboxSettings,
  claudeSessionSandboxState,
  type SessionSandboxState,
} from "@vtc/shared";
import { exec as defaultExec, type Exec } from "./process.js";

/** The project-local Claude settings file, relative to the repo root. */
export const CLAUDE_LOCAL_SETTINGS = ".claude/settings.local.json";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const lstatOrNull = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

export type LocalSettingsRead =
  | { readonly kind: "absent"; readonly path: string }
  | { readonly kind: "unreadable"; readonly path: string; readonly error: string }
  | { readonly kind: "ok"; readonly path: string; readonly settings: Record<string, unknown> };

/** The repo's `.claude/settings.local.json`, never through a symlink. */
export const readClaudeLocalSettings = (repoRoot: string): LocalSettingsRead => {
  const path = join(repoRoot, CLAUDE_LOCAL_SETTINGS);
  try {
    const dir = lstatOrNull(dirname(path));
    if (dir === null) return { kind: "absent", path };
    if (dir.isSymbolicLink())
      return { kind: "unreadable", path, error: `${dirname(path)} is a symbolic link` };
    if (!dir.isDirectory())
      return { kind: "unreadable", path, error: `${dirname(path)} is not a directory` };
    const file = lstatOrNull(path);
    if (file === null) return { kind: "absent", path };
    if (file.isSymbolicLink()) return { kind: "unreadable", path, error: "it is a symbolic link" };
    if (!file.isFile()) return { kind: "unreadable", path, error: "it is not a file" };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { kind: "unreadable", path, error: "it is not a JSON object" };
    return { kind: "ok", path, settings: parsed };
  } catch (error) {
    return {
      kind: "unreadable",
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export interface SessionSandboxReport {
  readonly state: SessionSandboxState;
  /** What `claudeSessionSandboxState` found missing (`sandbox.enabled`, a path, …). */
  readonly missing: readonly string[];
  readonly file: LocalSettingsRead["kind"];
  readonly path: string;
}

/** The session sandbox state the repo's settings give a Claude Code session. */
export const claudeSessionSandboxOf = (repoRoot: string, vtcHome: string): SessionSandboxReport => {
  const read = readClaudeLocalSettings(repoRoot);
  const { state, missing } = claudeSessionSandboxState(
    read.kind === "ok" ? read.settings : undefined,
    vtcHome,
  );
  return { state, missing, file: read.kind, path: read.path };
};

const union = (have: unknown, add: readonly string[]): unknown[] => {
  const list: unknown[] = Array.isArray(have) ? [...(have as unknown[])] : [];
  for (const entry of add) if (!list.includes(entry)) list.push(entry);
  return list;
};

/**
 * `existing` with every entry of `claudeSessionSandboxSettings(vtcHome)`: the sandbox on, no
 * unsandboxed escape, the deny lists extended. Every other key the user has stays as it was.
 */
export const mergeSessionSandboxSettings = (
  existing: Readonly<Record<string, unknown>>,
  vtcHome: string,
): Record<string, unknown> => {
  const wanted = claudeSessionSandboxSettings(vtcHome).sandbox;
  const sandbox = isRecord(existing.sandbox) ? existing.sandbox : {};
  const filesystem = isRecord(sandbox.filesystem) ? sandbox.filesystem : {};
  return {
    ...existing,
    sandbox: {
      ...sandbox,
      enabled: wanted.enabled,
      allowUnsandboxedCommands: wanted.allowUnsandboxedCommands,
      filesystem: {
        ...filesystem,
        denyRead: union(filesystem.denyRead, wanted.filesystem.denyRead),
        denyWrite: union(filesystem.denyWrite, wanted.filesystem.denyWrite),
      },
    },
  };
};

/**
 * Writes the settings without following a link: `.claude` must be a plain directory (created
 * when absent), the file a plain file or absent; a temp file created exclusively is renamed over.
 */
export const writeClaudeLocalSettings = (
  repoRoot: string,
  settings: Readonly<Record<string, unknown>>,
): string => {
  const path = join(repoRoot, CLAUDE_LOCAL_SETTINGS);
  const dir = dirname(path);
  const dirStat = lstatOrNull(dir);
  if (dirStat === null) mkdirSync(dir);
  else if (dirStat.isSymbolicLink())
    throw new Error(`${dir} is a symbolic link; vtc install does not follow it`);
  else if (!dirStat.isDirectory()) throw new Error(`${dir} exists and is not a directory`);
  const file = lstatOrNull(path);
  if (file?.isSymbolicLink() === true)
    throw new Error(`${path} is a symbolic link; vtc install does not follow it`);
  if (file !== null && !file.isFile()) throw new Error(`${path} exists and is not a file`);
  const temp = `${path}.${String(process.pid)}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`, { flag: "wx" });
  renameSync(temp, path);
  return path;
};

/**
 * Whether git keeps `relPath` (repo-relative) out of the repo: `tracked` (ignore rules do not
 * apply to a tracked file), `ignored`, or `added` after appending it to the repo's own
 * `info/exclude`, which is never committed and leaves the user's `.gitignore` alone.
 */
export const gitIgnoreStatus = async (
  repoRoot: string,
  relPath: string,
  run: Exec = defaultExec,
): Promise<"tracked" | "ignored" | "not-ignored"> => {
  const tracked = await run("git", ["ls-files", "--error-unmatch", "--", relPath], {
    cwd: repoRoot,
    timeoutMs: 5_000,
  });
  if (tracked.code === 0) return "tracked";
  const ignored = await run("git", ["check-ignore", "-q", "--", relPath], {
    cwd: repoRoot,
    timeoutMs: 5_000,
  });
  return ignored.code === 0 ? "ignored" : "not-ignored";
};

/** Appends `/<relPath>` to the repo's `info/exclude`; resolves the file it wrote. */
export const excludeFromGit = async (
  repoRoot: string,
  relPath: string,
  run: Exec = defaultExec,
): Promise<string> => {
  const result = await run("git", ["rev-parse", "--git-path", "info/exclude"], {
    cwd: repoRoot,
    timeoutMs: 5_000,
  });
  const reported = result.stdout.trim();
  if (result.code !== 0 || reported === "")
    throw new Error(`cannot find the git exclude file of ${repoRoot}`);
  const path = isAbsolute(reported) ? reported : resolve(repoRoot, reported);
  mkdirSync(dirname(path), { recursive: true });
  let current = "";
  try {
    current = readFileSync(path, "utf8");
  } catch {
    // no exclude file yet
  }
  const separator = current === "" || current.endsWith("\n") ? "" : "\n";
  appendFileSync(
    path,
    `${separator}# VTC: Claude Code session sandbox (local settings)\n/${relPath}\n`,
  );
  return path;
};
