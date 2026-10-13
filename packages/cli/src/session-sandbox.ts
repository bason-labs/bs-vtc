/**
 * The Claude Code session sandbox of a repo (D-an, spine §5 reading 71). In plugin-only dispatch
 * (AD-17) a code-running role is a subagent of the human's Lead session, so its shell is confined
 * only by that session's own sandbox. The settings live in the project's gitignored
 * `.claude/settings.local.json` ({@link sessionSandboxSettings}: the shared
 * `claudeSessionSandboxSettings` plus `failIfUnavailable`):
 * - the bridge reports their state in every hello ({@link sessionSandboxProbe}, `bridge.ts`);
 * - `vtc install --host claude-code` shows them, merges them in after the user confirms (keeping
 *   the user's other keys, dropping the local entries that would let a command past the sandbox)
 *   and makes sure git ignores the file;
 * - `vtc doctor` reports the state and what is missing or widening it.
 * The state is `on` only when the local file has every required key, no settings scope the
 * session loads from files (local, the repo's committed `.claude/settings.json`, the user's
 * `settings.json`) widens the sandbox ({@link wideningOf}), and the machine has what Claude Code's
 * sandbox needs ({@link sandboxToolsMissing}). Managed settings, `--settings` and
 * `--setting-sources` are outside what VTC can read (spine §7 residual row).
 * A cloned repo can commit `.claude` or a settings file as a symlink pointing anywhere, so neither
 * is ever followed: such a file reads as `unreadable` (state `unknown`) and is never written
 * through. The user's own settings file is theirs and may be a link (dotfiles).
 */
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, posix, resolve } from "node:path";
import {
  claudeSessionSandboxSettings,
  claudeSessionSandboxState,
  type HostId,
  type SessionSandboxState,
} from "@vtc/shared";
import { exec as defaultExec, type Exec } from "./process.js";

/** The project-local Claude settings file, relative to the repo root. */
export const CLAUDE_LOCAL_SETTINGS = ".claude/settings.local.json";
/** The repo's committed Claude settings file, relative to the repo root. */
export const CLAUDE_PROJECT_SETTINGS = ".claude/settings.json";

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

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A repo's `.claude/<file>`, never through a symlink. */
const readRepoSettings = (repoRoot: string, rel: string): LocalSettingsRead => {
  const path = join(repoRoot, rel);
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
    return { kind: "unreadable", path, error: errorText(error) };
  }
};

/** The repo's `.claude/settings.local.json`, never through a symlink. */
export const readClaudeLocalSettings = (repoRoot: string): LocalSettingsRead =>
  readRepoSettings(repoRoot, CLAUDE_LOCAL_SETTINGS);

/** The user's own settings file (it may be a link). */
const readUserSettings = (path: string): LocalSettingsRead => {
  try {
    if (!existsSync(path)) return { kind: "absent", path };
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) return { kind: "unreadable", path, error: "it is not a JSON object" };
    return { kind: "ok", path, settings: parsed };
  } catch (error) {
    return { kind: "unreadable", path, error: errorText(error) };
  }
};

/** Where the session sandbox state is read from; injected in tests (never the real home). */
export interface SessionSandboxEnv {
  /** The user's Claude settings file; `null` leaves it out. */
  readonly userSettings: string | null;
  /** The user's home, for `~` in sandbox paths. */
  readonly homeDir: string;
  readonly platform: NodeJS.Platform;
  /** `PATH`, searched (absolute entries only) for the Linux sandbox's `bwrap` and `socat`. */
  readonly pathEnv: string;
  readonly exists: (path: string) => boolean;
}

/** The real machine: `$CLAUDE_CONFIG_DIR/settings.json` (absolute) or `~/.claude/settings.json`. */
export const defaultSessionSandboxEnv = (): SessionSandboxEnv => {
  const configured = process.env.CLAUDE_CONFIG_DIR;
  const configDir =
    configured !== undefined && isAbsolute(configured) ? configured : join(homedir(), ".claude");
  return {
    userSettings: join(configDir, "settings.json"),
    homeDir: homedir(),
    platform: process.platform,
    pathEnv: process.env.PATH ?? "",
    exists: existsSync,
  };
};

/** Where macOS ships the Seatbelt front end Claude Code's sandbox uses. */
const SEATBELT = "/usr/bin/sandbox-exec";

/**
 * What Claude Code's sandbox needs that this machine lacks: Seatbelt on macOS, `bwrap` and
 * `socat` on Linux; no sandbox elsewhere. With `failIfUnavailable` Claude Code then refuses to
 * start, but the bridge does not count on it: anything missing makes the state `unknown`.
 */
export const sandboxToolsMissing = (
  platform: NodeJS.Platform,
  pathEnv: string,
  exists: (path: string) => boolean,
): string[] => {
  if (platform === "darwin") return exists(SEATBELT) ? [] : [SEATBELT];
  if (platform === "linux") {
    const dirs = pathEnv.split(delimiter).filter((d) => d !== "" && isAbsolute(d));
    return ["bwrap", "socat"].filter((tool) => !dirs.some((d) => exists(join(d, tool))));
  }
  return [`a Claude Code sandbox on ${platform}`];
};

/** The settings `vtc install --host claude-code` writes: the shared ones and `failIfUnavailable`. */
export const sessionSandboxSettings = (
  vtcHome: string,
): {
  readonly sandbox: ReturnType<typeof claudeSessionSandboxSettings>["sandbox"] & {
    readonly failIfUnavailable: true;
  };
} => ({
  sandbox: { ...claudeSessionSandboxSettings(vtcHome).sandbox, failIfUnavailable: true },
});

/** Where a settings file's sandbox paths resolve: relative ones against `base`, `~` to home. */
export interface SettingsSource {
  readonly path: string;
  readonly base: string;
  readonly homeDir: string;
}

const GLOB = /[*?[{]/;

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

const expand = (entry: string, source: Pick<SettingsSource, "base" | "homeDir">): string => {
  const tilde =
    entry === "~"
      ? source.homeDir
      : entry.startsWith("~/")
        ? `${source.homeDir}${entry.slice(1)}`
        : entry;
  return posix.resolve(source.base, tilde);
};

/**
 * Whether a sandbox path entry reaches into the VTC home: at or under it, or a glob whose literal
 * directory is an ancestor or descendant of it (it could match a denied path). A plain ancestor
 * (`~/`) does not: the narrower deny keeps holding inside a wider allow.
 */
const reachesVtcHome = (
  entry: string,
  source: Pick<SettingsSource, "base" | "homeDir">,
  vtcHome: string,
): boolean => {
  const home = posix.resolve(vtcHome);
  const glob = entry.search(GLOB);
  if (glob === -1) return within(expand(entry, source), home);
  const literal = entry.slice(0, glob);
  const dir = expand(literal.slice(0, literal.lastIndexOf("/") + 1) || ".", source);
  return within(dir, home) || within(home, dir);
};

const jsonOf = (value: unknown): string => JSON.stringify(value);

/** The keys whose `true` lets sandboxed commands past a restriction VTC relies on. */
const WIDENING_FLAGS = [
  ["enableWeakerNestedSandbox"],
  ["network", "allowAllUnixSockets"],
  ["filesystem", "disabled"],
] as const;

/** The path lists whose entries can re-open a denied VTC home path. */
const WIDENING_LISTS = [
  ["sandbox", "filesystem", "allowRead"],
  ["sandbox", "filesystem", "allowWrite"],
  ["sandbox", "network", "allowUnixSockets"],
  ["permissions", "additionalDirectories"],
] as const;

const at = (value: unknown, keys: readonly string[]): unknown =>
  keys.reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), value);

/** The entries of a path list that reach the VTC home; a value that is not a string list counts whole. */
const reaching = (
  value: unknown,
  source: Pick<SettingsSource, "base" | "homeDir">,
  vtcHome: string,
): { readonly whole: boolean; readonly entries: readonly string[] } => {
  if (value === undefined) return { whole: false, entries: [] };
  if (!Array.isArray(value) || !value.every((e): e is string => typeof e === "string"))
    return { whole: true, entries: [] };
  return { whole: false, entries: value.filter((e) => reachesVtcHome(e, source, vtcHome)) };
};

/**
 * Pure: what in one parsed settings file lets a sandboxed command reach what VTC denies, one line
 * each (`<key> <entries> in <path>`): `sandbox.excludedCommands` (matching commands run with no
 * sandbox at all, `allowUnsandboxedCommands: false` notwithstanding), `enableWeakerNestedSandbox`,
 * `network.allowAllUnixSockets` or `filesystem.disabled` set, and an `allowRead`, `allowWrite`,
 * `allowUnixSockets` or `permissions.additionalDirectories` entry reaching the VTC home.
 */
export const wideningOf = (
  settings: unknown,
  source: SettingsSource,
  vtcHome: string,
): string[] => {
  const out: string[] = [];
  const sandbox = isRecord(settings) ? settings.sandbox : undefined;
  const excluded = at(sandbox, ["excludedCommands"]);
  if (excluded !== undefined && !(Array.isArray(excluded) && excluded.length === 0))
    out.push(`sandbox.excludedCommands ${jsonOf(excluded)} in ${source.path}`);
  for (const keys of WIDENING_FLAGS) {
    const value = at(sandbox, keys);
    if (value !== undefined && value !== false)
      out.push(`sandbox.${keys.join(".")} in ${source.path}`);
  }
  for (const keys of WIDENING_LISTS) {
    const value = at(settings, keys);
    const hit = reaching(value, source, vtcHome);
    if (hit.whole) out.push(`${keys.join(".")} ${jsonOf(value)} in ${source.path}`);
    else if (hit.entries.length > 0)
      out.push(`${keys.join(".")} ${jsonOf(hit.entries)} in ${source.path}`);
  }
  return out;
};

export interface SessionSandboxReport {
  readonly state: SessionSandboxState;
  /** Required keys the local file lacks (`sandbox.enabled`, `sandbox.failIfUnavailable`, a path). */
  readonly missing: readonly string[];
  /** Settings that let commands past the sandbox, or a settings file that cannot be read. */
  readonly widening: readonly string[];
  /** What Claude Code's sandbox needs that this machine lacks ({@link sandboxToolsMissing}). */
  readonly unavailable: readonly string[];
  readonly file: LocalSettingsRead["kind"];
  readonly path: string;
}

/** The session sandbox state the repo's and the user's settings give a Claude Code session. */
export const claudeSessionSandboxOf = (
  repoRoot: string,
  vtcHome: string,
  env: SessionSandboxEnv,
): SessionSandboxReport => {
  const local = readClaudeLocalSettings(repoRoot);
  const shared = claudeSessionSandboxState(
    local.kind === "ok" ? local.settings : undefined,
    vtcHome,
  );
  const missing = [...shared.missing];
  if (local.kind === "ok" && at(local.settings, ["sandbox", "failIfUnavailable"]) !== true)
    missing.push("sandbox.failIfUnavailable");
  const widening: string[] = [];
  let unreadable = false;
  const repoSource = (path: string): SettingsSource => ({
    path,
    base: repoRoot,
    homeDir: env.homeDir,
  });
  const reads: [LocalSettingsRead, SettingsSource][] = [];
  if (local.kind === "ok") reads.push([local, repoSource(local.path)]);
  const project = readRepoSettings(repoRoot, CLAUDE_PROJECT_SETTINGS);
  reads.push([project, repoSource(project.path)]);
  if (env.userSettings !== null) {
    const user = readUserSettings(env.userSettings);
    reads.push([user, { path: user.path, base: dirname(user.path), homeDir: env.homeDir }]);
  }
  for (const [read, source] of reads) {
    if (read.kind === "unreadable") {
      unreadable = true;
      widening.push(`${read.path} cannot be read (${read.error})`);
    } else if (read.kind === "ok") widening.push(...wideningOf(read.settings, source, vtcHome));
  }
  const unavailable = sandboxToolsMissing(env.platform, env.pathEnv, env.exists);
  const state: SessionSandboxState =
    local.kind !== "ok" || unreadable
      ? "unknown"
      : missing.length > 0 || widening.length > 0
        ? "off"
        : unavailable.length > 0
          ? "unknown"
          : shared.state;
  return { state, missing, widening, unavailable, file: local.kind, path: local.path };
};

/**
 * The bridge's `sessionSandbox` callback: on Claude Code in a repo, the state read afresh for
 * every hello (Claude Code reloads edited settings mid-session, so a snapshot would go stale);
 * nothing for Codex or outside a repository.
 */
export const sessionSandboxProbe = (
  repoRoot: string | null,
  host: HostId,
  vtcHome: string,
  env: SessionSandboxEnv,
): (() => SessionSandboxState) | undefined =>
  repoRoot === null || host !== "claude-code"
    ? undefined
    : () => claudeSessionSandboxOf(repoRoot, vtcHome, env).state;

const union = (have: unknown, add: readonly string[]): unknown[] => {
  const list: unknown[] = Array.isArray(have) ? [...(have as unknown[])] : [];
  for (const entry of add) if (!list.includes(entry)) list.push(entry);
  return list;
};

/** `record` without `key`. */
const omit = (record: Record<string, unknown>, key: string): Record<string, unknown> =>
  Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));

/** A path list without the entries reaching the VTC home; one that is not a string list goes. */
const keepOutside = (
  record: Record<string, unknown>,
  key: string,
  source: Pick<SettingsSource, "base" | "homeDir">,
  vtcHome: string,
): Record<string, unknown> => {
  const value = record[key];
  if (value === undefined) return record;
  const hit = reaching(value, source, vtcHome);
  if (hit.whole) return omit(record, key);
  return {
    ...record,
    [key]: (value as string[]).filter((e) => !hit.entries.includes(e)),
  };
};

/**
 * `existing` with every entry of {@link sessionSandboxSettings}: the sandbox on, no unsandboxed
 * escape, no unsandboxed fallback, the deny lists extended; and without what {@link wideningOf}
 * would list for it (relative paths resolve against `projectRoot`). Every other key the user has
 * stays as it was.
 */
export const mergeSessionSandboxSettings = (
  existing: Readonly<Record<string, unknown>>,
  vtcHome: string,
  paths: { readonly projectRoot: string; readonly homeDir: string },
): Record<string, unknown> => {
  const source = { base: paths.projectRoot, homeDir: paths.homeDir };
  const wanted = sessionSandboxSettings(vtcHome).sandbox;
  let sandbox = isRecord(existing.sandbox) ? omit(existing.sandbox, "excludedCommands") : {};
  sandbox = omit(sandbox, "enableWeakerNestedSandbox");
  let filesystem = isRecord(sandbox.filesystem) ? omit(sandbox.filesystem, "disabled") : {};
  filesystem = keepOutside(filesystem, "allowRead", source, vtcHome);
  filesystem = keepOutside(filesystem, "allowWrite", source, vtcHome);
  const network = isRecord(sandbox.network)
    ? keepOutside(omit(sandbox.network, "allowAllUnixSockets"), "allowUnixSockets", source, vtcHome)
    : undefined;
  const permissions = isRecord(existing.permissions)
    ? keepOutside(existing.permissions, "additionalDirectories", source, vtcHome)
    : undefined;
  return {
    ...existing,
    ...(permissions === undefined ? {} : { permissions }),
    sandbox: {
      ...sandbox,
      ...(network === undefined ? {} : { network }),
      enabled: wanted.enabled,
      allowUnsandboxedCommands: wanted.allowUnsandboxedCommands,
      failIfUnavailable: wanted.failIfUnavailable,
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
