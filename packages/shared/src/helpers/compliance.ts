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
  // Codex: trusts repo hooks without the user's review (contracts 4.5.0, AD-25)
  "dangerously-bypass-hook-trust",
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
  /**
   * `vtc <subcommand>` no role may run: `calibrate`, and since 4.6.0 the human gestures
   * `lookback` (approve, pin, rollback; AD-21 rule 3) and `merge-level` (restore; AD-23 rule 5),
   * spine §5 reading 119.
   */
  subcommands: ["calibrate", "lookback", "merge-level"],
  /**
   * Globs relative to the VTC home that no role may write (a bare name is one file). Since 4.6.0
   * it includes {@link WAVE3_HOME_WRITE_DENY} (the wave-3 merge, reading 119).
   */
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
    "lookback/**",
    "research-cache/**",
    "browsers/**",
    "design-library/**",
  ],
  /** Globs relative to the VTC home that no role may read (a bare name is one file). */
  homeReadDeny: ["token", "run/**", "hidden/**"],
} as const;

/**
 * Globs under the VTC home that wave 3 adds (contracts 4.5.0) and that no role may write: Lookback
 * versions and pins (AD-21), the research cache (AD-22), the pinned browser store (AD-24) and the
 * design library (§9.1). Folded into {@link ROLE_DENIED_VTC}`.homeWriteDeny` at the wave-3 merge
 * (contracts 4.6.0, spine §5 readings 103 and 119); kept as its own list for the code that names
 * the wave-3 stores.
 */
export const WAVE3_HOME_WRITE_DENY = [
  "lookback/**",
  "research-cache/**",
  "browsers/**",
  "design-library/**",
] as const;

const vtcHomePath = (vtcHome: string, glob: string): string => {
  if (!isAbsolutePath(vtcHome) || vtcHome.includes("\\")) {
    throw new TypeError(`expected an absolute POSIX VTC home, got ${vtcHome}`);
  }
  const base = vtcHome.length > 1 ? vtcHome.replace(/\/+$/, "") : vtcHome;
  return `${base}/${glob.replace(/\/\*\*$/, "")}`;
};

/**
 * Credential stores under the user's home that no role or gate needs: SSH and cloud keys,
 * registry and git credentials, the Docker and Kubernetes configs, the user's keychains and Claude
 * Code's own config file. Relative to the user's home; never opened, only written into deny rules
 * (the gate sandbox, D-al, and the Lead session's sandbox, {@link claudeSessionSandboxSettings}).
 */
export const HOME_CREDENTIAL_LOCATIONS: readonly string[] = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".config/hub",
  ".config/op",
  ".config/git/credentials",
  ".config/containers",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".yarnrc",
  ".yarnrc.yml",
  ".bunfig.toml",
  ".pypirc",
  ".cargo/credentials",
  ".cargo/credentials.toml",
  ".gem/credentials",
  ".gradle/gradle.properties",
  ".m2/settings.xml",
  ".m2/settings-security.xml",
  ".terraform.d/credentials.tfrc.json",
  ".vault-token",
  ".pgpass",
  ".docker",
  ".kube",
  ".gnupg",
  ".password-store",
  ".local/share/keyrings",
  ".claude.json",
  "Library/Keychains",
];

/**
 * What no role may do with the project's own engine files, relative to the repo's main checkout
 * (spine §5 reading 79). `readDeny`: the engine's verification checkouts, which hold the hidden
 * acceptance tests during a gate run (§7.3), and the raw gate output, which holds what the hidden
 * runs printed. `writeDeny`: the same, plus the run config a role must not widen for the next
 * run (`project.yaml`: merge level, allowlists, risk rules; `gates.yml`). Since 4.6.0 (spine §5
 * reading 119) also the engine's own git-tracked records: the merge-level ledger (only a human
 * restores, AD-23 rule 5), the facts table (AD-22; the briefs and the repo map under
 * `.vtc/research/` stay writable), the Lookback attributions, replays and
 * scorecards (AD-21; the lookback role's `proposals/` stay writable) and the engine's novelty
 * reports. Role worktrees (`.vtc/state/worktrees/`) stay writable; engine core's write-scope
 * check keeps a role diff from carrying these paths into the integration branch.
 */
export const REPO_ROLE_DENIED = {
  readDeny: [".vtc/state/checkouts/**", ".vtc/state/gates/**"],
  writeDeny: [
    ".vtc/state/checkouts/**",
    ".vtc/state/gates/**",
    ".vtc/project.yaml",
    ".vtc/gates.yml",
    ".vtc/merge-level.jsonl",
    ".vtc/research/facts.jsonl",
    ".vtc/lookback/attributions.jsonl",
    ".vtc/lookback/replays/**",
    ".vtc/lookback/scorecards/**",
    ".vtc/design/novelty/**",
  ],
} as const;

/**
 * Where the Lead session's sandbox settings resolve the paths beyond the VTC home: the repo they
 * are written for, the user's home ({@link HOME_CREDENTIAL_LOCATIONS}) and each host's config
 * directory (its credential files, `hostCredentialDenyReadPaths`). Absolute POSIX paths.
 */
export interface SessionSandboxScope {
  /** The repo's main checkout, where `vtc install` writes `.claude/settings.local.json`. */
  readonly projectRoot: string;
  /** The user's home. */
  readonly homeDir: string;
  /** Each host's config directory: `$CLAUDE_CONFIG_DIR` / `$CODEX_HOME`, or the default. */
  readonly hostConfigDirs: Readonly<Partial<Record<HostId, string>>>;
}

/**
 * Each host's config directory as the host itself resolves it: the absolute value of its
 * `configDirEnv` variable, or its default directory under `homeDir`. Pure string joins.
 */
export const hostConfigDirsOf = (
  env: Readonly<Record<string, string | undefined>>,
  homeDir: string,
): Record<HostId, string> => {
  const home = homeDir.length > 1 ? homeDir.replace(/\/+$/, "") : homeDir;
  const dirOf = (host: HostId): string => {
    const entry = HOST_CREDENTIAL_DENY_READ[host];
    const moved = env[entry.configDirEnv];
    return moved !== undefined && moved.startsWith("/")
      ? moved
      : `${home}/${entry.defaultConfigDir}`;
  };
  return { "claude-code": dirOf("claude-code"), codex: dirOf("codex") };
};

const underRoot = (root: string, rel: string, what: string): string => {
  if (!root.startsWith("/") || root.includes("\\")) {
    throw new TypeError(`expected an absolute POSIX ${what}, got ${root}`);
  }
  const base = root.length > 1 ? root.replace(/\/+$/, "") : "";
  return `${base}/${rel.replace(/\/\*\*$/, "")}`;
};

/**
 * How a shell command may spell a path under the default VTC home, or under `$VTC_HOME` (the
 * cli's override). Claude Code matches a Bash rule against the command text as written, so each
 * spelling needs its own rule ({@link claudeSessionPermissionDeny}).
 */
export const VTC_HOME_SHELL_SPELLINGS: readonly string[] = [
  "~/.vtc",
  "$HOME/.vtc",
  "${HOME}/.vtc",
  "$VTC_HOME",
  "${VTC_HOME}",
];

/** `Read`/`Edit` rules for one absolute path: the path and, unless it is a credential file, below it. */
const pathRules = (tool: "Read" | "Edit", path: string): string[] =>
  isHostCredentialDenyRead(path)
    ? [`${tool}(/${path})`]
    : [`${tool}(/${path})`, `${tool}(/${path}/**)`];

/**
 * The `permissions.deny` rules of the Lead session's settings (spine §5 reading 81). Claude Code's
 * sandbox lists (`sandbox.filesystem.denyRead`/`denyWrite`) confine shell commands only; its
 * built-in file tools (`Read`, `Edit`, `Write`, and on a best-effort basis `Grep`/`Glob`) follow
 * permission rules instead, for the Lead and for every in-session role subagent. So every
 * sandbox path is repeated as a `Read(//<abs>)` (read deny) or `Edit(//<abs>)` (write deny; Edit
 * rules cover every file-editing tool) rule, plus `/**` for directories; `vtc calibrate` is denied
 * as a command; and the shell spellings of each guarded VTC home path ({@link
 * VTC_HOME_SHELL_SPELLINGS}) are denied as Bash text, a best-effort first line behind the
 * sandbox. Deny rules win over every allow rule, so no allow entry can widen them. Pure string
 * joins; credential files appear only as single-file `Read(...)` rules, which the D-ad
 * exemption covers.
 */
export const claudeSessionPermissionDeny = (
  vtcHome: string,
  scope: SessionSandboxScope,
): string[] => {
  const { denyRead, denyWrite } = claudeSessionSandboxLists(vtcHome, scope);
  const homeRoots = [
    ...new Set(
      [...ROLE_DENIED_VTC.homeWriteDeny, ...ROLE_DENIED_VTC.homeReadDeny].map((g) =>
        g.replace(/\/\*\*$/, ""),
      ),
    ),
  ];
  return [
    ...new Set([
      ...denyRead.flatMap((p) => pathRules("Read", p)),
      ...denyWrite.flatMap((p) => pathRules("Edit", p)),
      ...ROLE_DENIED_VTC.subcommands.flatMap((sub) => [`Bash(vtc ${sub})`, `Bash(vtc ${sub} *)`]),
      ...homeRoots.flatMap((root) =>
        VTC_HOME_SHELL_SPELLINGS.map((home) => `Bash(*${home}/${root}*)`),
      ),
    ]),
  ];
};

const claudeSessionSandboxLists = (
  vtcHome: string,
  scope: SessionSandboxScope,
): { readonly denyRead: string[]; readonly denyWrite: string[] } => ({
  denyRead: [
    ...new Set([
      ...ROLE_DENIED_VTC.homeReadDeny.map((glob) => vtcHomePath(vtcHome, glob)),
      ...hostCredentialDenyReadPaths(scope.hostConfigDirs),
      ...HOME_CREDENTIAL_LOCATIONS.map((rel) => underRoot(scope.homeDir, rel, "home")),
      ...REPO_ROLE_DENIED.readDeny.map((glob) =>
        underRoot(scope.projectRoot, glob, "project root"),
      ),
    ]),
  ],
  denyWrite: [
    ...new Set([
      ...ROLE_DENIED_VTC.homeWriteDeny.map((glob) => vtcHomePath(vtcHome, glob)),
      ...REPO_ROLE_DENIED.writeDeny.map((glob) =>
        underRoot(scope.projectRoot, glob, "project root"),
      ),
    ]),
  ],
});

/**
 * The Claude Code session settings a Lead session needs before the engine runs a role in it
 * (D-an, spine §5 readings 71, 79 and 81). In plugin-only dispatch (AD-17) every role is a
 * subagent of the human's Lead session, so its shell is confined only by that session's own
 * sandbox and its file tools only by that session's permission rules. `vtc install --host
 * claude-code` (an explicit user command) shows the user and then writes these keys into the
 * project's gitignored `.claude/settings.local.json`; {@link claudeSessionSandboxState} reads
 * them back. Sandbox reads are denied on `homeReadDeny`, on each host's credential files and
 * {@link HOME_CREDENTIAL_LOCATIONS} (what the gate sandbox and the headless profiles already
 * deny) and on {@link REPO_ROLE_DENIED}`.readDeny`; writes on `homeWriteDeny` and
 * `REPO_ROLE_DENIED.writeDeny`. `permissions.deny` ({@link claudeSessionPermissionDeny}) repeats
 * them for the file tools, which the sandbox does not cover. Absolute POSIX paths, pure string
 * joins: nothing is opened (D-ad).
 */
export const claudeSessionSandboxSettings = (
  vtcHome: string,
  scope: SessionSandboxScope,
): {
  readonly sandbox: {
    readonly enabled: true;
    readonly allowUnsandboxedCommands: false;
    readonly filesystem: { readonly denyRead: string[]; readonly denyWrite: string[] };
  };
  readonly permissions: { readonly deny: string[] };
} => ({
  sandbox: {
    enabled: true,
    allowUnsandboxedCommands: false,
    filesystem: claudeSessionSandboxLists(vtcHome, scope),
  },
  permissions: { deny: claudeSessionPermissionDeny(vtcHome, scope) },
});

/**
 * Pure: whether parsed Claude settings (the project's `.claude/settings.local.json`) turn the
 * session sandbox on with every entry of {@link claudeSessionSandboxSettings}: `sandbox.enabled`
 * true, `allowUnsandboxedCommands` false, every read and write deny path present, and every
 * `permissions.deny` rule present. `missing` lists what is not there (`sandbox.enabled`,
 * `sandbox.allowUnsandboxedCommands`, a path or a rule). Settings that cannot be read are
 * `unknown`, which the engine treats like `off` (fail closed).
 */
export const claudeSessionSandboxState = (
  settings: unknown,
  vtcHome: string,
  scope: SessionSandboxScope,
): { readonly state: SessionSandboxState; readonly missing: readonly string[] } => {
  if (!isRecord(settings)) return { state: "unknown", missing: ["sandbox"] };
  const wanted = claudeSessionSandboxSettings(vtcHome, scope);
  const sandbox = isRecord(settings.sandbox) ? settings.sandbox : {};
  const filesystem = isRecord(sandbox.filesystem) ? sandbox.filesystem : {};
  const permissions = isRecord(settings.permissions) ? settings.permissions : {};
  const listed = (list: unknown): readonly unknown[] => (Array.isArray(list) ? list : []);
  const missing = [
    ...(sandbox.enabled === true ? [] : ["sandbox.enabled"]),
    ...(sandbox.allowUnsandboxedCommands === false ? [] : ["sandbox.allowUnsandboxedCommands"]),
    ...wanted.sandbox.filesystem.denyRead.filter((p) => !listed(filesystem.denyRead).includes(p)),
    ...wanted.sandbox.filesystem.denyWrite.filter((p) => !listed(filesystem.denyWrite).includes(p)),
    ...wanted.permissions.deny.filter((r) => !listed(permissions.deny).includes(r)),
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
