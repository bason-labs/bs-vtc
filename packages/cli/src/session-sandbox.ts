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
 * The state is `on` only when the local file has every required key, no settings file the
 * session loads (local, the committed `.claude/settings.json`, both again at the session cwd and
 * its work tree's top level, the user's `settings.json`) widens the sandbox ({@link wideningOf}:
 * any sandbox key not known to be safe counts), and the machine has what Claude Code's sandbox
 * needs ({@link sandboxToolsMissing}). Managed settings, `--settings` and `--setting-sources` are
 * outside what VTC can read (spine §7 residual row).
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
  realpathSync,
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
  hostConfigDirsOf,
  MERGE_LEVEL_LEDGER,
  VTC_HOME_SHELL_SPELLINGS,
  WAVE3_HOME_WRITE_DENY,
  type HostId,
  type SessionSandboxScope,
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
  /**
   * Each host's config directory, whose credential files the sandbox read-denies (reading 79):
   * `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME` when absolute. Default: the hosts' defaults under
   * `homeDir`.
   */
  readonly hostConfigDirs?: Readonly<Partial<Record<HostId, string>>>;
}

/** Where the shared settings resolve their paths for `repoRoot` on this machine (reading 79). */
export const sandboxScopeOf = (
  repoRoot: string,
  env: Pick<SessionSandboxEnv, "homeDir" | "hostConfigDirs">,
): SessionSandboxScope => ({
  projectRoot: repoRoot,
  homeDir: env.homeDir,
  hostConfigDirs: env.hostConfigDirs ?? hostConfigDirsOf({}, env.homeDir),
});

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
    hostConfigDirs: hostConfigDirsOf(process.env, homedir()),
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

/**
 * The `vtc` subcommands that are human gestures (spine AD-21 rule 3, AD-23 rule 5; readings 103,
 * 104): they confirm only at an interactive terminal, but a pty is not proof of a human, so the
 * Lead session denies them as commands the way the shared rules deny `vtc calibrate`. The cli
 * adds them until the integrator puts them in `ROLE_DENIED_VTC.subcommands` (contract proposal).
 */
export const GESTURE_SUBCOMMANDS = ["lookback", "merge-level"] as const;

/**
 * What the Lead session denies on top of the shared settings, until the integrator folds it into
 * the shared lists (every list is deduplicated, so the fold changes nothing here):
 * - the wave-3 VTC home paths no role may write (`WAVE3_HOME_WRITE_DENY`: Lookback versions and
 *   pins, the research cache, the browser store, the design library; spine §5 reading 103), as
 *   sandbox write denies, `Edit` rules for the file tools and the shell spellings as Bash text,
 *   exactly as the shared settings do for `homeWriteDeny`;
 * - the repo's merge-level ledger (`MERGE_LEVEL_LEDGER`, AD-23 rule 5: only a human restores), as
 *   a sandbox write deny and an `Edit` rule, the way the shared settings deny `project.yaml`;
 * - the gesture subcommands ({@link GESTURE_SUBCOMMANDS}) as Bash rules.
 */
export const wave3SessionDenies = (
  vtcHome: string,
  projectRoot: string,
): { readonly denyWrite: string[]; readonly permissionDeny: string[] } => {
  const base = vtcHome.length > 1 ? vtcHome.replace(/\/+$/, "") : vtcHome;
  const roots = WAVE3_HOME_WRITE_DENY.map((glob) => glob.replace(/\/\*\*$/, ""));
  const homePaths = roots.map((root) => `${base}/${root}`);
  const repo = projectRoot.length > 1 ? projectRoot.replace(/\/+$/, "") : "";
  const ledger = `${repo}/${MERGE_LEVEL_LEDGER}`;
  return {
    denyWrite: [...homePaths, ledger],
    permissionDeny: [
      ...homePaths.flatMap((path) => [`Edit(/${path})`, `Edit(/${path}/**)`]),
      `Edit(/${ledger})`,
      ...roots.flatMap((root) => VTC_HOME_SHELL_SPELLINGS.map((home) => `Bash(*${home}/${root}*)`)),
      ...GESTURE_SUBCOMMANDS.flatMap((sub) => [`Bash(vtc ${sub})`, `Bash(vtc ${sub} *)`]),
    ],
  };
};

/**
 * The settings `vtc install --host claude-code` writes: the shared ones (the sandbox and the
 * file-tool `permissions.deny` rules, spine §5 reading 81), the wave-3 denies
 * ({@link wave3SessionDenies}) and `failIfUnavailable`.
 */
export const sessionSandboxSettings = (
  vtcHome: string,
  scope: SessionSandboxScope,
): {
  readonly sandbox: ReturnType<typeof claudeSessionSandboxSettings>["sandbox"] & {
    readonly failIfUnavailable: true;
  };
  readonly permissions: ReturnType<typeof claudeSessionSandboxSettings>["permissions"];
} => {
  const shared = claudeSessionSandboxSettings(vtcHome, scope);
  const wave3 = wave3SessionDenies(vtcHome, scope.projectRoot);
  return {
    sandbox: {
      ...shared.sandbox,
      filesystem: {
        ...shared.sandbox.filesystem,
        denyWrite: [...new Set([...shared.sandbox.filesystem.denyWrite, ...wave3.denyWrite])],
      },
      failIfUnavailable: true,
    },
    permissions: { deny: [...new Set([...shared.permissions.deny, ...wave3.permissionDeny])] },
  };
};

/**
 * Where a settings file's sandbox paths resolve: relative ones against `base` (and, failing
 * closed where Claude Code's own rule is not known, against every `also` dir), `~` to home.
 */
export interface SettingsSource {
  readonly path: string;
  readonly base: string;
  readonly homeDir: string;
  readonly also?: readonly string[];
}

type PathBase = Pick<SettingsSource, "base" | "homeDir">;

const GLOB = /[*?[{]/;

const within = (path: string, root: string): boolean =>
  path === root || path.startsWith(root === "/" ? "/" : `${root}/`);

const expand = (entry: string, source: PathBase): string => {
  const tilde =
    entry === "~"
      ? source.homeDir
      : entry.startsWith("~/")
        ? `${source.homeDir}${entry.slice(1)}`
        : entry;
  return posix.resolve(source.base, tilde);
};

/**
 * Whether a sandbox path entry reaches into a guarded root (the VTC home, or another path the
 * sandbox denies): at or under it, or a glob whose literal directory is an ancestor or descendant
 * of it (it could match a denied path). A plain ancestor (`~/`) does not: the narrower deny keeps
 * holding inside a wider allow.
 */
const reachesGuarded = (entry: string, source: PathBase, roots: readonly string[]): boolean => {
  const glob = entry.search(GLOB);
  const literal = glob === -1 ? "" : entry.slice(0, glob);
  const target =
    glob === -1
      ? expand(entry, source)
      : expand(literal.slice(0, literal.lastIndexOf("/") + 1) || ".", source);
  return roots.some((root) => {
    const guarded = posix.resolve(root);
    return glob === -1
      ? within(target, guarded)
      : within(target, guarded) || within(guarded, target);
  });
};

/**
 * The roots no allow entry may reach: the VTC home and, with a `scope`, every other path the
 * shared settings deny (credential stores, the engine's gate checkouts and output, the run
 * config; spine §5 reading 79).
 */
export const guardedRoots = (vtcHome: string, scope?: SessionSandboxScope): string[] => {
  if (scope === undefined) return [vtcHome];
  const { denyRead, denyWrite } = claudeSessionSandboxSettings(vtcHome, scope).sandbox.filesystem;
  const wave3 = wave3SessionDenies(vtcHome, scope.projectRoot).denyWrite;
  return [...new Set([vtcHome, ...denyRead, ...denyWrite, ...wave3])];
};

const jsonOf = (value: unknown): string => JSON.stringify(value);

/**
 * How a settings key is judged (D-an, fix round 2: anything not known to be safe counts):
 * - `nonEmpty`: widening unless absent or `[]` (`excludedCommands` run with no sandbox at all,
 *   `allowUnsandboxedCommands: false` notwithstanding; `allowMachLookup` reaches XPC services
 *   outside the sandbox);
 * - `flag`: widening unless absent or `false`;
 * - `platforms`: widening when the list leaves out a name Claude Code may give this platform;
 * - `paths`: the entries reaching the VTC home.
 */
type Check = "nonEmpty" | "flag" | "platforms" | "paths";

/** The keys that can open what VTC denies, in the order they are reported. */
const RULES: readonly (readonly [Check, readonly string[]])[] = [
  ["nonEmpty", ["sandbox", "excludedCommands"]],
  ["flag", ["sandbox", "enableWeakerNestedSandbox"]],
  ["flag", ["sandbox", "network", "allowAllUnixSockets"]],
  ["flag", ["sandbox", "filesystem", "disabled"]],
  // sandboxed commands can launch other applications unsandboxed (`open -a Terminal x.command`)
  ["flag", ["sandbox", "allowAppleEvents"]],
  ["flag", ["sandbox", "enableWeakerNetworkIsolation"]],
  ["flag", ["sandbox", "network", "allowLocalBinding"]],
  ["nonEmpty", ["sandbox", "network", "allowMachLookup"]],
  ["platforms", ["sandbox", "enabledPlatforms"]],
  ["paths", ["sandbox", "filesystem", "allowRead"]],
  ["paths", ["sandbox", "filesystem", "allowWrite"]],
  ["paths", ["sandbox", "network", "allowUnixSockets"]],
  ["paths", ["permissions", "additionalDirectories"]],
];

/** The nested sandbox objects, checked key by key. */
const SECTIONS = ["network", "filesystem"] as const;

/**
 * The sandbox keys known not to open what VTC denies: the required ones (another value is checked
 * where it can win, {@link requiredOverridesOf}), prompting and reporting, credential protection,
 * domain lists and proxies (VTC denies files and sockets, not domains), narrowing deny lists.
 * Every other key, today's (`bwrapPath`, `ripgrep`, ...) or a later one, counts as widening.
 */
const SAFE: Readonly<Record<"sandbox" | (typeof SECTIONS)[number], readonly string[]>> = {
  sandbox: [
    "enabled",
    "failIfUnavailable",
    "allowUnsandboxedCommands",
    "autoAllowBashIfSandboxed",
    "ignoreViolations",
    "credentials",
  ],
  network: [
    "allowedDomains",
    "deniedDomains",
    "strictAllowlist",
    "allowManagedDomainsOnly",
    "httpProxyPort",
    "socksProxyPort",
    "tlsTerminate",
  ],
  filesystem: ["denyRead", "denyWrite", "allowManagedReadPathsOnly"],
};

/** The names Claude Code gives `platform` in `sandbox.enabledPlatforms` (Linux may be `wsl`). */
const claudePlatformNames = (platform: NodeJS.Platform): readonly string[] =>
  platform === "darwin"
    ? ["macos"]
    : platform === "linux"
      ? ["linux", "wsl"]
      : platform === "win32"
        ? ["windows"]
        : [platform];

const at = (value: unknown, keys: readonly string[]): unknown =>
  keys.reduce<unknown>((v, k) => (isRecord(v) ? v[k] : undefined), value);

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((e) => typeof e === "string");

/** The entries of a path list that reach a guarded root; a value that is not a string list counts whole. */
const reaching = (
  value: unknown,
  source: Pick<SettingsSource, "base" | "homeDir" | "also">,
  roots: readonly string[],
): { readonly whole: boolean; readonly entries: readonly string[] } => {
  if (value === undefined) return { whole: false, entries: [] };
  if (!isStringList(value)) return { whole: true, entries: [] };
  const bases = [source.base, ...(source.also ?? [])];
  return {
    whole: false,
    entries: value.filter((e) =>
      bases.some((base) => reachesGuarded(e, { base, homeDir: source.homeDir }, roots)),
    ),
  };
};

/** One widening finding: the key, the list entries to drop (else the whole key), the text. */
interface Widening {
  readonly keys: readonly string[];
  readonly entries?: readonly string[];
  readonly text: string;
}

const UNKNOWN = "(not known to keep the sandbox closed)";

const findWidening = (
  settings: unknown,
  source: Pick<SettingsSource, "base" | "homeDir" | "also">,
  roots: readonly string[],
  platform: NodeJS.Platform,
): Widening[] => {
  const out: Widening[] = [];
  const sandbox = at(settings, ["sandbox"]);
  for (const [check, keys] of RULES) {
    const value = at(settings, keys);
    if (value === undefined) continue;
    const name = keys.join(".");
    if (check === "nonEmpty") {
      if (!(Array.isArray(value) && value.length === 0))
        out.push({ keys, text: `${name} ${jsonOf(value)}` });
    } else if (check === "flag") {
      if (value !== false) out.push({ keys, text: name });
    } else if (check === "platforms") {
      const left = claudePlatformNames(platform).filter(
        (p) => !(isStringList(value) && value.includes(p)),
      );
      if (left.length > 0)
        out.push({ keys, text: `${name} ${jsonOf(value)} (leaves out ${left.join(", ")})` });
    } else {
      const hit = reaching(value, source, roots);
      if (hit.whole) out.push({ keys, text: `${name} ${jsonOf(value)}` });
      else if (hit.entries.length > 0)
        out.push({ keys, entries: hit.entries, text: `${name} ${jsonOf(hit.entries)}` });
    }
  }
  const known = new Set(RULES.map(([, keys]) => keys.join(".")));
  const unknownIn = (value: unknown, keys: readonly string[], safe: readonly string[]): void => {
    if (value === undefined) return;
    if (!isRecord(value)) {
      out.push({ keys, text: `${keys.join(".")} ${jsonOf(value)} ${UNKNOWN}` });
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      const path = [...keys, key];
      if (safe.includes(key) || known.has(path.join("."))) continue;
      if (keys.length === 1 && (SECTIONS as readonly string[]).includes(key)) continue;
      out.push({ keys: path, text: `${path.join(".")} ${jsonOf(entry)} ${UNKNOWN}` });
    }
  };
  unknownIn(sandbox, ["sandbox"], SAFE.sandbox);
  if (isRecord(sandbox))
    for (const section of SECTIONS)
      unknownIn(sandbox[section], ["sandbox", section], SAFE[section]);
  return out;
};

/**
 * Pure: what in one parsed settings file lets a sandboxed command reach what VTC denies, one line
 * each (`<key> <entries> in <path>`): a {@link RULES} key set (`excludedCommands`,
 * `allowAppleEvents`, `enableWeakerNestedSandbox`, `enableWeakerNetworkIsolation`,
 * `filesystem.disabled`, `network.allowAllUnixSockets`, `network.allowLocalBinding`, a
 * `network.allowMachLookup`, an `enabledPlatforms` leaving out `platform`), an `allowRead`,
 * `allowWrite`, `allowUnixSockets` or `permissions.additionalDirectories` entry reaching the VTC
 * home, and any sandbox key not known to be safe ({@link SAFE}), so a key added later fails closed.
 */
export const wideningOf = (
  settings: unknown,
  source: SettingsSource,
  vtcHome: string,
  platform: NodeJS.Platform = process.platform,
  scope?: SessionSandboxScope,
): string[] =>
  findWidening(settings, source, guardedRoots(vtcHome, scope), platform).map(
    (w) => `${w.text} in ${source.path}`,
  );

/** The values the main local file must hold; another value elsewhere may win over it. */
const REQUIRED: readonly (readonly [string, boolean])[] = [
  ["enabled", true],
  ["allowUnsandboxedCommands", false],
  ["failIfUnavailable", true],
];

/**
 * A required key (`enabled`, `allowUnsandboxedCommands`, `failIfUnavailable`) set to another
 * value in a local settings file other than the main one (a linked worktree's, or the legacy
 * `<cwd>/.claude/settings.local.json` Claude Code merges in from a subdirectory), where it is not
 * known which of the two wins.
 */
const requiredOverridesOf = (settings: unknown, path: string): string[] =>
  REQUIRED.flatMap(([key, wanted]) => {
    const value = at(settings, ["sandbox", key]);
    return value === undefined || value === wanted
      ? []
      : [`sandbox.${key} ${jsonOf(value)} in ${path}`];
  });

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

const canonical = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
};

/** The nearest directory at or above `dir` holding a `.git` entry (its work tree's top level). */
const workTreeTop = (dir: string): string | null => {
  for (let d = dir; ; d = dirname(d)) {
    try {
      if (lstatOrNull(join(d, ".git")) !== null) return d;
    } catch {
      return null;
    }
    if (dirname(d) === d) return null;
  }
};

/**
 * The session sandbox state the repo's and the user's settings give a Claude Code session started
 * in `cwd` (the repo root by default). Claude Code takes the local tier from the main checkout
 * (`repoRoot`, where `vtc install` writes it) and the project tier from `<cwd>/.claude`, merging
 * a legacy `<cwd>/.claude/settings.local.json` in when `cwd` is elsewhere; a Lead session can
 * start in a linked worktree or a subdirectory. So the widening check reads `settings.json` and
 * `settings.local.json` of the main checkout, of `cwd`'s work tree top level and of `cwd` itself,
 * each resolving relative paths against its own project dir (and `cwd`), plus the user's file.
 */
export const claudeSessionSandboxOf = (
  repoRoot: string,
  vtcHome: string,
  env: SessionSandboxEnv,
  cwd: string = repoRoot,
): SessionSandboxReport => {
  const local = readClaudeLocalSettings(repoRoot);
  const scope = sandboxScopeOf(repoRoot, env);
  const shared = claudeSessionSandboxState(
    local.kind === "ok" ? local.settings : undefined,
    vtcHome,
    scope,
  );
  const missing = [...shared.missing];
  if (local.kind === "ok" && at(local.settings, ["sandbox", "failIfUnavailable"]) !== true)
    missing.push("sandbox.failIfUnavailable");
  if (local.kind === "ok") {
    const listed = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
    const wave3 = wave3SessionDenies(vtcHome, repoRoot);
    const denyWrite = listed(at(local.settings, ["sandbox", "filesystem", "denyWrite"]));
    const deny = listed(at(local.settings, ["permissions", "deny"]));
    for (const path of wave3.denyWrite)
      if (!denyWrite.includes(path) && !missing.includes(path)) missing.push(path);
    for (const rule of wave3.permissionDeny)
      if (!deny.includes(rule) && !missing.includes(rule)) missing.push(rule);
  }
  const widening: string[] = [];
  let unreadable = false;
  const sessionDir = canonical(cwd);
  const root = canonical(repoRoot);
  const source = (path: string, base: string): SettingsSource => ({
    path,
    base,
    homeDir: env.homeDir,
    also: [sessionDir],
  });
  const reads: { read: LocalSettingsRead; source: SettingsSource; otherLocal: boolean }[] = [];
  if (local.kind === "ok")
    reads.push({ read: local, source: source(local.path, repoRoot), otherLocal: false });
  const project = readRepoSettings(repoRoot, CLAUDE_PROJECT_SETTINGS);
  reads.push({ read: project, source: source(project.path, repoRoot), otherLocal: false });
  const top = workTreeTop(sessionDir);
  const dirs = [...new Set([top, sessionDir].filter((d): d is string => d !== null))].filter(
    (d) => d !== root,
  );
  for (const dir of dirs)
    for (const rel of [CLAUDE_PROJECT_SETTINGS, CLAUDE_LOCAL_SETTINGS]) {
      const read = readRepoSettings(dir, rel);
      reads.push({
        read,
        source: source(read.path, dir),
        otherLocal: rel === CLAUDE_LOCAL_SETTINGS,
      });
    }
  if (env.userSettings !== null) {
    const user = readUserSettings(env.userSettings);
    reads.push({ read: user, source: source(user.path, dirname(user.path)), otherLocal: false });
  }
  for (const { read, source: from, otherLocal } of reads) {
    if (read.kind === "unreadable") {
      unreadable = true;
      widening.push(`${read.path} cannot be read (${read.error})`);
    } else if (read.kind === "ok") {
      widening.push(...wideningOf(read.settings, from, vtcHome, env.platform, scope));
      if (otherLocal) widening.push(...requiredOverridesOf(read.settings, read.path));
    }
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
 * The bridge's `sessionSandbox` callback: on Claude Code in a repo, the state of a session started
 * in `cwd`, read afresh for every hello (Claude Code reloads edited settings mid-session, so a
 * snapshot would go stale); nothing for Codex or outside a repository.
 */
export const sessionSandboxProbe = (
  repoRoot: string | null,
  host: HostId,
  vtcHome: string,
  env: SessionSandboxEnv,
  cwd?: string,
): (() => SessionSandboxState) | undefined =>
  repoRoot === null || host !== "claude-code"
    ? undefined
    : () => claudeSessionSandboxOf(repoRoot, vtcHome, env, cwd ?? repoRoot).state;

const union = (have: unknown, add: readonly string[]): unknown[] => {
  const list: unknown[] = Array.isArray(have) ? [...(have as unknown[])] : [];
  for (const entry of add) if (!list.includes(entry)) list.push(entry);
  return list;
};

/** `value` without the key at `keys`, or with `entries` filtered out of the list there. */
const without = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
  entries?: readonly string[],
): Record<string, unknown> => {
  const [key, ...rest] = keys;
  if (key === undefined || !(key in value)) return { ...value };
  if (rest.length > 0) {
    const inner = value[key];
    return isRecord(inner) ? { ...value, [key]: without(inner, rest, entries) } : { ...value };
  }
  if (entries === undefined)
    return Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));
  const list = value[key];
  return {
    ...value,
    [key]: Array.isArray(list) ? list.filter((e) => !entries.includes(e as string)) : list,
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
  paths: {
    readonly projectRoot: string;
    readonly homeDir: string;
    readonly platform?: NodeJS.Platform;
    readonly hostConfigDirs?: Readonly<Partial<Record<HostId, string>>>;
  },
): Record<string, unknown> => {
  const source = { base: paths.projectRoot, homeDir: paths.homeDir };
  const scope = sandboxScopeOf(paths.projectRoot, paths);
  const kept = findWidening(
    existing,
    source,
    guardedRoots(vtcHome, scope),
    paths.platform ?? process.platform,
  ).reduce((settings, w) => without(settings, w.keys, w.entries), { ...existing });
  const settings = sessionSandboxSettings(vtcHome, scope);
  const wanted = settings.sandbox;
  const sandbox = isRecord(kept.sandbox) ? kept.sandbox : {};
  const filesystem = isRecord(sandbox.filesystem) ? sandbox.filesystem : {};
  const permissions = isRecord(kept.permissions) ? kept.permissions : {};
  return {
    ...kept,
    permissions: { ...permissions, deny: union(permissions.deny, settings.permissions.deny) },
    sandbox: {
      ...sandbox,
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
