/**
 * AD-9 markers: host permission-bypass flags and host credential locations VTC must never use
 * (§12.5, §15). `eslint.config.js` builds its AD-9 lint rule from the same list (a test keeps
 * them equal). Adapter contract tests run `findForbiddenHostArgs` on every command and installed
 * file; compiler and repo tests run `findForbiddenInText` on role, skill and plugin sources and
 * on every emitted plugin file (AD-9).
 */
import type { SessionSandboxState } from "../engine-instance.js";
import type { HostId } from "../primitives.js";

export const AD9_FORBIDDEN_MARKERS = [
  // permission / sandbox bypass flags and modes
  "dangerously-skip-permissions",
  "dangerously-bypass-approvals-and-sandbox",
  "bypassPermissions",
  "--yolo",
  "danger-full-access",
  // host credentials
  ".credentials.json",
  "auth.json",
  "find-generic-password",
  "Claude Code-credentials",
  // credential environment variables (VTC runs on the user's own signed-in host, D2)
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
] as const;

const hasMarker = (text: string): boolean => {
  const lower = text.toLowerCase();
  return AD9_FORBIDDEN_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
};

/**
 * Every argument that contains a forbidden marker (case-insensitive). One exemption (D-ad,
 * spine §5 reading 50): an argument that is a JSON object (e.g. Claude's `--settings` value, or
 * `JSON.stringify(profile.settings)`) is checked **after** removing the read-deny entries for host
 * credential files ({@link isHostCredentialDenyRead}) from exactly two deny lists,
 * `permissions.deny` and `sandbox.filesystem.denyRead`. A marker anywhere else, including the
 * same path in an allow list or in any other argument, is still reported.
 */
export const findForbiddenHostArgs = (args: readonly string[]): string[] =>
  args.filter((arg) => hasMarker(withoutHostCredentialDenies(arg)));

// --------------------------------------------------- host credential deny-read

/**
 * Host credential files, named **only** so a role sandbox can deny reading them (D-ad, spine §5
 * reading 50). The AD-9 rule stands: VTC never reads, stats, opens, copies or stores these files.
 * They exist here to be written into a host's read-deny settings (Claude
 * `permissions.deny` `Read(...)` rules and `sandbox.filesystem.denyRead`) and nowhere else; this
 * file is the one place a credential marker may appear in source (AD-9 Check), so adapters build
 * the deny entries with {@link hostCredentialDenyReadPaths} and never spell the names out.
 *
 * Per host: the environment variable that relocates the host's config directory, the directory's
 * default name under the user's home, and the credential files inside it. The caller resolves the
 * directory (`$<configDirEnv>` or `<home>/<defaultConfigDir>`); nothing here touches the disk.
 * Codex has no per-path read deny, so a Codex role cannot be kept from reading them (the engine
 * gives no role a network route that could send them anywhere, D-ac).
 */
export const HOST_CREDENTIAL_DENY_READ = {
  "claude-code": {
    configDirEnv: "CLAUDE_CONFIG_DIR",
    defaultConfigDir: ".claude",
    files: [".credentials.json"],
  },
  codex: { configDirEnv: "CODEX_HOME", defaultConfigDir: ".codex", files: ["auth.json"] },
} as const satisfies Readonly<
  Record<
    HostId,
    {
      readonly configDirEnv: string;
      readonly defaultConfigDir: string;
      readonly files: readonly string[];
    }
  >
>;

const isAbsolutePath = (path: string): boolean => path.startsWith("/") || /^[A-Za-z]:\//.test(path);

/**
 * The absolute credential-file paths to deny reading, for each host config directory given
 * (already resolved by the caller, absolute, POSIX separators). Pure string joins: the result is
 * only ever written into deny rules, never opened (D-ad).
 */
export const hostCredentialDenyReadPaths = (
  configDirs: Readonly<Partial<Record<HostId, string>>>,
): string[] =>
  (Object.keys(HOST_CREDENTIAL_DENY_READ) as HostId[]).flatMap((host) => {
    const dir = configDirs[host];
    if (dir === undefined) return [];
    if (!isAbsolutePath(dir) || dir.includes("\\")) {
      throw new TypeError(`expected an absolute POSIX config directory for ${host}, got ${dir}`);
    }
    const base = dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
    return HOST_CREDENTIAL_DENY_READ[host].files.map((file) => `${base}/${file}`);
  });

const CREDENTIAL_FILES: readonly string[] = Object.values(HOST_CREDENTIAL_DENY_READ).flatMap(
  (entry) => entry.files,
);

/**
 * True when `entry` denies reading exactly one host credential file: an absolute path (`/…`,
 * Claude's rule form `//…`, or `~/…`) whose last segment is a credential file, either bare (a
 * `denyRead` entry) or wrapped as `Read(<path>)` (a `permissions.deny` rule). No wildcards,
 * braces, brackets, parentheses, commas, backslashes, `..` segments or control characters, so
 * the entry can name nothing else.
 */
export const isHostCredentialDenyRead = (entry: string): boolean => {
  const path = /^Read\((.*)\)$/.exec(entry)?.[1] ?? entry;
  // eslint-disable-next-line no-control-regex -- control characters are what this rejects
  if (!/^(\/|~\/)/.test(path) || /[\u0000-\u001f\u007f*?(),{}[\]\\]/.test(path)) return false;
  if (path.split("/").includes("..")) return false;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return CREDENTIAL_FILES.includes(name);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const withoutDenies = (list: unknown): unknown =>
  Array.isArray(list)
    ? list.filter((entry) => !(typeof entry === "string" && isHostCredentialDenyRead(entry)))
    : list;

/** The JSON text with credential read-denies removed from the two sanctioned deny lists. */
const withoutHostCredentialDenies = (arg: string): string => {
  if (!arg.trimStart().startsWith("{")) return arg;
  let parsed: unknown;
  try {
    parsed = JSON.parse(arg);
  } catch {
    return arg;
  }
  if (!isRecord(parsed)) return arg;
  const settings = { ...parsed };
  if (isRecord(settings.permissions)) {
    settings.permissions = {
      ...settings.permissions,
      deny: withoutDenies(settings.permissions.deny),
    };
  }
  if (isRecord(settings.sandbox) && isRecord(settings.sandbox.filesystem)) {
    settings.sandbox = {
      ...settings.sandbox,
      filesystem: {
        ...settings.sandbox.filesystem,
        denyRead: withoutDenies(settings.sandbox.filesystem.denyRead),
      },
    };
  }
  return JSON.stringify(settings);
};

// ------------------------------------------------------------ role deny list

/**
 * What no role may do with VTC itself, on either host (D-w, spine §5 reading 43; AD-13 rule 10,
 * §15: only a human widens the gate allowlist, and a role must not tamper with the scanner
 * database or the hidden tests). Every compiled role profile and every adapter sandbox profile
 * denies running these `vtc` subcommands and writing these globs under the VTC home (`~/.vtc/`,
 * or `$VTC_HOME`). `vtc calibrate` also confirms only in an interactive terminal and has no
 * `--yes` flag, but a pty is not proof of a human, so the host sandbox is the barrier.
 *
 * `homeWriteDeny` (D-ap, spine §5 reading 73) also covers everything under the VTC home that is
 * later run or trusted with the user's full privileges: the pinned scanner binaries
 * (`scanners/**`), the Claude plugin the Lead session loads (`claude-marketplace/**`) and the
 * extracted plugin headless runs load (`plugins/**`), the user config with its
 * `env_passthrough` and `gates.allow_unsandboxed` (`config.yaml`), the discovery files and
 * sockets (`engines/**`, `run/**`) and the install token (`token`). An entry without `/**` is a
 * single file. `homeReadDeny` (D-an, spine §5 reading 71) is what no role, and no shell of a
 * Lead session that runs roles in-session, may read: the install token, the daemons' sockets
 * (a client there could declare itself the cli) and the hidden acceptance tests (§7.3).
 */
export const ROLE_DENIED_VTC = {
  /** `vtc <subcommand>` no role may run. */
  subcommands: ["calibrate"],
  /** Globs relative to the VTC home that no role may write (a bare name is one file). */
  homeWriteDeny: [
    "allowlists/**",
    "osv-db/**",
    "hidden/**",
    "scanners/**",
    "claude-marketplace/**",
    "plugins/**",
    "engines/**",
    "run/**",
    "config.yaml",
    "token",
  ],
  /** Globs relative to the VTC home that no role may read (a bare name is one file). */
  homeReadDeny: ["token", "run/**", "hidden/**"],
} as const;

const vtcHomePath = (vtcHome: string, glob: string): string => {
  if (!isAbsolutePath(vtcHome) || vtcHome.includes("\\")) {
    throw new TypeError(`expected an absolute POSIX VTC home, got ${vtcHome}`);
  }
  const base = vtcHome.length > 1 ? vtcHome.replace(/\/+$/, "") : vtcHome;
  return `${base}/${glob.replace(/\/\*\*$/, "")}`;
};

/**
 * The Claude Code session sandbox a Lead session needs before the engine runs a code-running
 * role in it (D-an, spine §5 reading 71). In plugin-only dispatch (AD-17) an Engineer-family
 * role is a subagent of the human's Lead session, so its shell is confined only by that
 * session's own sandbox. `vtc install --host claude-code` (an explicit user command) shows the
 * user and then writes these keys into the project's gitignored `.claude/settings.local.json`;
 * {@link claudeSessionSandboxState} reads them back. Absolute POSIX paths, pure string joins.
 */
export const claudeSessionSandboxSettings = (
  vtcHome: string,
): {
  readonly sandbox: {
    readonly enabled: true;
    readonly allowUnsandboxedCommands: false;
    readonly filesystem: { readonly denyRead: string[]; readonly denyWrite: string[] };
  };
} => ({
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    filesystem: {
      denyRead: ROLE_DENIED_VTC.homeReadDeny.map((glob) => vtcHomePath(vtcHome, glob)),
      denyWrite: ROLE_DENIED_VTC.homeWriteDeny.map((glob) => vtcHomePath(vtcHome, glob)),
    },
  },
});

/**
 * Pure: whether parsed Claude settings (the project's `.claude/settings.local.json`) turn the
 * session sandbox on with every entry of {@link claudeSessionSandboxSettings}: `sandbox.enabled`
 * true, `allowUnsandboxedCommands` false, and every read and write deny present. `missing` lists
 * what is not there (`sandbox.enabled`, `sandbox.allowUnsandboxedCommands`, or a path). Settings
 * that cannot be read are `unknown`, which the engine treats like `off` (fail closed).
 */
export const claudeSessionSandboxState = (
  settings: unknown,
  vtcHome: string,
): { readonly state: SessionSandboxState; readonly missing: readonly string[] } => {
  if (!isRecord(settings)) return { state: "unknown", missing: ["sandbox"] };
  const wanted = claudeSessionSandboxSettings(vtcHome).sandbox;
  const sandbox = isRecord(settings.sandbox) ? settings.sandbox : {};
  const filesystem = isRecord(sandbox.filesystem) ? sandbox.filesystem : {};
  const listed = (list: unknown): readonly unknown[] => (Array.isArray(list) ? list : []);
  const missing = [
    ...(sandbox.enabled === true ? [] : ["sandbox.enabled"]),
    ...(sandbox.allowUnsandboxedCommands === false ? [] : ["sandbox.allowUnsandboxedCommands"]),
    ...wanted.filesystem.denyRead.filter((p) => !listed(filesystem.denyRead).includes(p)),
    ...wanted.filesystem.denyWrite.filter((p) => !listed(filesystem.denyWrite).includes(p)),
  ];
  return { state: missing.length === 0 ? "on" : "off", missing };
};

/** One marker hit in a text file. */
export interface ForbiddenMarkerHit {
  /** 1-based line number. */
  readonly line: number;
  readonly marker: string;
}

/** Every line of `text` that contains a forbidden marker (case-insensitive), with the marker. */
export const findForbiddenInText = (text: string): ForbiddenMarkerHit[] => {
  const hits: ForbiddenMarkerHit[] = [];
  text.split("\n").forEach((content, index) => {
    const lower = content.toLowerCase();
    for (const marker of AD9_FORBIDDEN_MARKERS) {
      if (lower.includes(marker.toLowerCase())) hits.push({ line: index + 1, marker });
    }
  });
  return hits;
};
