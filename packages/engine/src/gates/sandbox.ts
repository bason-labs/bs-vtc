/**
 * The gate sandbox (D-al, spine §5 reading 69, AD-13 rule 11; spec §7.2 two-phase sandbox). Every
 * command the Gate Runner starts (calibration, L0–L5, guards, Final Review, the OSV database
 * download) runs through a {@link GateSandbox}:
 *
 * - macOS: `/usr/bin/sandbox-exec` with a profile generated here ({@link sandboxExecProfile}). The
 *   profile starts from `(deny default)`: the command may fork, exec, read files (narrowed below),
 *   signal and inspect its own sandbox, and look up a short list of system services
 *   ({@link GATE_MACH_SERVICES}); LaunchServices, AppleEvents, background downloads, the
 *   pasteboard and the keychain stay out of reach, so nothing it does can have launchd start code
 *   outside the sandbox. Paths reach the profile as `-D` parameters, never spliced into its text.
 *   The command runs under an in-sandbox reaper ({@link REAPER_SCRIPT}) that kills everything left
 *   in the sandbox when the command ends (macOS has no PID namespace).
 * - Linux: `bwrap` ({@link bwrapArgs}): a minimal root of read-only system directories and
 *   toolchains (never the host root, so no host `/run`, `/tmp` or `/var/run` and none of the
 *   pathname IPC sockets in them), the checkout and the private directories bound writable, its
 *   own PID namespace (everything dies with the command) and always a network namespace of its
 *   own, so the host's abstract Unix sockets (an X server's `@/tmp/.X11-unix/X0`, a
 *   `unix:abstract=` D-Bus bus), which belong to a network namespace and not to the filesystem,
 *   do not exist inside: in the verify phase bwrap's own (a private loopback only), in the install
 *   phase the one `pasta` ({@link PASTA_ARGS}) creates, with user-mode IP networking, no port
 *   forwarding in either direction and no gateway mapped to the host's loopback.
 *
 * Rules, the same in both: the verify phase has no network; the install phase gets IP networking
 * (neither tool can filter by registry host, so `WrappedGateCommand.network` says `full`) with the
 * same filesystem rules and no Unix socket outside the writable directories (on macOS DNS goes
 * through mDNSResponder, on Linux through pasta's forwarder); writes only to the checkout, the
 * command's private temp directory, the phase's empty `HOME` (the install phase and the verify
 * phase never share one: spine §5 reading 252) and the run's dependency download caches (the Go
 * module cache and Cargo's registry, which `go mod download` and `cargo fetch` fill for the
 * verify phase; no tool reads configuration there). Reads follow {@link gateReadPolicy}: the real home and the repo's
 * `.vtc/state` are hidden except the toolchains, the VTC home entries the gates run with, the
 * repo's git directory and the command's own checkout; the deny list (VTC home, host config and
 * credential stores, the repo's evidence) is never readable. The environment is the allowlist of
 * `exec.ts` with `HOME` and the temp variables pointed at the per-run directories and `VTC_HOME`
 * unset ({@link sandboxEnv}).
 *
 * With no sandbox the Gate Runner runs nothing (`GATE_SANDBOX.noSandboxReason`), unless the user
 * opted in with `gates.allow_unsandboxed` in `~/.vtc/config.yaml`: then {@link UNSANDBOXED} runs
 * the argv as it is (same environment rules) and the report says `sandbox: "none"`.
 *
 * Known limits (gates/README.md): on macOS the verify phase also refuses loopback sockets (the
 * host's loopback is shared with the engine and other local services), so a test suite that opens
 * a localhost server fails there; on Linux it gets a private loopback. Writes to the shared git
 * directory of the checkout's worktree are refused too, so a gate cannot change the repo's git
 * state.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import {
  GATE_SANDBOX,
  HOME_CREDENTIAL_LOCATIONS,
  HOST_CREDENTIAL_DENY_READ,
  hostCredentialDenyReadPaths,
  ROLE_DENIED_VTC,
  type GatePhase,
  type GateSandbox,
  type GateSandboxKind,
  type GateSandboxSpec,
  type HostId,
  type WrappedGateCommand,
} from "@vtc/shared";
import { runCommand, type ExecRequest, type ExecResult } from "./exec.js";

type Env = Readonly<Record<string, string | undefined>>;

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Entries of the VTC home a gate reads: the pinned scanner store (`scanners.ts` `SCANNERS_DIR`),
 * VTC's Opengrep rules (`rules.ts` `RULES_DIR`), the OSV offline database (`osv-db.ts`
 * `OSV_DB_DIR`) and the browser store the visual runner launches from (`BROWSERS_DIR`, AD-24;
 * binaries and pins, no secrets). Everything else there is read-denied. Spelled out here (a test
 * keeps them equal) so this module imports none of them.
 */
export const GATE_READABLE_VTC_HOME: readonly string[] = [
  "scanners",
  "rules",
  "osv-db",
  "browsers",
];

/**
 * Credential stores under the user's home that no gate needs (the shared list, which the Lead
 * session's sandbox denies too, spine §5 reading 79). Never opened; only written into deny rules.
 */
export { HOME_CREDENTIAL_LOCATIONS };

/** Variables of the gate allowlist that point a tool's writable cache outside the sandbox. */
export const SANDBOX_DROPPED_ENV: readonly string[] = [
  "VTC_HOME",
  "GOPATH",
  "GOCACHE",
  "GOMODCACHE",
  "CARGO_HOME",
];

const stripGlob = (glob: string): string => glob.replace(/\/\*\*$/, "");

/**
 * The absolute paths a gate may not read: every entry of the VTC home except
 * {@link GATE_READABLE_VTC_HOME} (plus the read- and write-denied names of `ROLE_DENIED_VTC`
 * whether they exist yet or not), each host's config directory (`$CLAUDE_CONFIG_DIR` /
 * `$CODEX_HOME`, or its default under `HOME`), the host credential files in them
 * (`hostCredentialDenyReadPaths`) and {@link HOME_CREDENTIAL_LOCATIONS}. Lists the VTC home's
 * entry names; opens nothing.
 */
export const gateDenyReadPaths = (vtcHome: string, env: Env = process.env): string[] => {
  const home = env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : homedir();
  const names = new Set<string>([
    ...ROLE_DENIED_VTC.homeReadDeny.map(stripGlob),
    ...ROLE_DENIED_VTC.homeWriteDeny.map(stripGlob),
  ]);
  try {
    for (const name of readdirSync(vtcHome)) names.add(name);
  } catch {
    // no VTC home yet: the fixed names still apply
  }
  const out = [...names]
    .filter((name) => !GATE_READABLE_VTC_HOME.includes(name))
    .sort()
    .map((name) => join(vtcHome, name));
  const dirs: Partial<Record<HostId, string>> = {};
  for (const host of Object.keys(HOST_CREDENTIAL_DENY_READ) as HostId[]) {
    const entry = HOST_CREDENTIAL_DENY_READ[host];
    const moved = env[entry.configDirEnv];
    dirs[host] =
      moved !== undefined && isAbsolute(moved) ? moved : join(home, entry.defaultConfigDir);
  }
  out.push(...Object.values(dirs), ...hostCredentialDenyReadPaths(dirs));
  out.push(...HOME_CREDENTIAL_LOCATIONS.map((p) => join(home, p)));
  return [...new Set(out)];
};

/**
 * Variables naming a toolchain's install root. Their absolute values stay readable inside the
 * hidden home ({@link gateToolchainRoots}).
 */
export const TOOLCHAIN_ROOT_ENV: readonly string[] = [
  "NVM_DIR",
  "VOLTA_HOME",
  "PNPM_HOME",
  "BUN_INSTALL",
  "RUSTUP_HOME",
  "CARGO_HOME",
  "PYENV_ROOT",
  "JAVA_HOME",
  "GOROOT",
  "GOPATH",
  "VIRTUAL_ENV",
  "SDKMAN_DIR",
  "ASDF_DATA_DIR",
  "ASDF_DIR",
  "FNM_DIR",
  "N_PREFIX",
  "DENO_INSTALL",
  "NODENV_ROOT",
  "RBENV_ROOT",
  "HOMEBREW_PREFIX",
  "CONDA_PREFIX",
  "GEM_HOME",
  "MISE_DATA_DIR",
];

/** PATH entries whose parent is the toolchain's root (`…/node/v22/bin` needs `…/node/v22/lib`). */
const PREFIXED_BIN_DIRS: ReadonlySet<string> = new Set(["bin", "sbin", "shims"]);

/** Whether `path` is `dir` or inside it (both absolute and normalized). */
const within = (path: string, dir: string): boolean =>
  path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * The toolchain roots a gate reads inside the hidden home: every absolute `PATH` entry (its parent
 * for a `bin`, `sbin` or `shims` directory, so a Node, Python or Ruby install finds its libraries,
 * except directly under a hidden directory or `.local`) and the absolute values of
 * {@link TOOLCHAIN_ROOT_ENV}. A root that is a hidden directory or contains one is left out: it
 * would make the hidden directory readable again.
 */
export const gateToolchainRoots = (env: Env, hidden: readonly string[]): string[] => {
  const roots: string[] = [];
  const exposes = (dir: string): boolean => hidden.some((h) => within(resolvePath(h), dir));
  const keep = (dir: string): boolean => {
    if (exposes(dir)) return false;
    if (!roots.includes(dir)) roots.push(dir);
    return true;
  };
  for (const entry of (env.PATH ?? "").split(delimiter)) {
    if (entry === "" || !isAbsolute(entry)) continue;
    const dir = resolvePath(entry);
    const parent = dirname(dir);
    const prefixed =
      PREFIXED_BIN_DIRS.has(basename(dir)) &&
      parent !== dirname(parent) &&
      basename(parent) !== ".local" &&
      !hidden.some((h) => resolvePath(h) === parent);
    if (!(prefixed && keep(parent))) keep(dir);
  }
  for (const key of TOOLCHAIN_ROOT_ENV) {
    const value = env[key];
    if (value !== undefined && isAbsolute(value)) keep(resolvePath(value));
  }
  return roots;
};

/**
 * The repository's shared git directory: `.git` itself, or for a linked worktree the directory
 * its `commondir` names. Verification checkouts are linked worktrees of the repo, so `git` in a
 * gate needs it. Reads only the repo's own git metadata; `null` when there is none.
 */
export const gitCommonDir = (repoRoot: string): string | null => {
  const dotGit = join(repoRoot, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return realpathSync(dotGit);
    const match = /^gitdir:\s*(.+?)\s*$/m.exec(readFileSync(dotGit, "utf8"));
    if (match?.[1] === undefined) return null;
    const gitDir = resolvePath(repoRoot, match[1]);
    let common = gitDir;
    try {
      common = resolvePath(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
    } catch {
      // a gitdir without commondir is its own common directory
    }
    return realpathSync(common);
  } catch {
    return null;
  }
};

/** What a gate command may read (the sandbox enforces it; nothing here opens the paths). */
export interface GateReadPolicy {
  /** Never readable, not even their names' metadata on macOS. */
  readonly denyRead: readonly string[];
  /** Contents unreadable (names and metadata stay visible on macOS), except {@link allowRead}. */
  readonly hideRead: readonly string[];
  /** Readable again inside {@link hideRead}; {@link denyRead} still wins. */
  readonly allowRead: readonly string[];
}

/**
 * The read policy of a run's gate commands: the real home (both `$HOME` and the account's home)
 * and the repo's `.vtc/state` (other checkouts and the raw logs of hidden-test runs) are hidden;
 * the toolchains ({@link gateToolchainRoots}), the VTC home entries the gates run with
 * ({@link GATE_READABLE_VTC_HOME}) and the repo's git directory stay readable, and the command's
 * own checkout is readable and writable. Denied: {@link gateDenyReadPaths} and the repo's
 * `.vtc/evidence`.
 */
export const gateReadPolicy = (options: {
  readonly vtcHome: string;
  readonly env?: Env;
  readonly repoRoot?: string;
  /** The account's home (default `os.homedir()`). */
  readonly homedir?: string;
}): GateReadPolicy => {
  const env = options.env ?? process.env;
  const account = options.homedir ?? homedir();
  const home = env.HOME !== undefined && isAbsolute(env.HOME) ? env.HOME : account;
  const repo = options.repoRoot;
  const hideRead = [
    ...new Set([home, account]),
    ...(repo === undefined ? [] : [join(repo, ".vtc", "state")]),
  ];
  const common = repo === undefined ? null : gitCommonDir(repo);
  return {
    denyRead: [
      ...gateDenyReadPaths(options.vtcHome, env),
      ...(repo === undefined ? [] : [join(repo, ".vtc", "evidence")]),
    ],
    hideRead,
    allowRead: [
      ...new Set([
        ...gateToolchainRoots(env, hideRead),
        ...GATE_READABLE_VTC_HOME.map((name) => join(options.vtcHome, name)),
        ...(common === null ? [] : [common]),
      ]),
    ],
  };
};

/**
 * The spec a {@link GateCommandJail} hands the sandbox: the contract's `GateSandboxSpec` plus the
 * hidden and readable roots of {@link GateReadPolicy} and the reaper's sentinel. A sandbox that
 * knows nothing of the extra fields still gets every contract rule.
 */
export interface GateJailSpec extends GateSandboxSpec {
  readonly hideRead?: readonly string[];
  readonly allowRead?: readonly string[];
  /**
   * A file in the run's private root (outside every writable directory). The macOS profile
   * denies reading it, and {@link REAPER_SCRIPT} kills only when it cannot read it, so the reaper
   * never kills anything outside a sandbox.
   */
  readonly reapSentinel?: string;
  /**
   * A `resolv.conf` in the run's private root naming pasta's DNS forwarder
   * ({@link PASTA_DNS_FORWARD}); the Linux install phase mounts it where `/etc/resolv.conf`
   * points, since the host's resolver is often on its loopback, which pasta's namespace does not
   * share.
   */
  readonly resolvConf?: string;
  /**
   * Verify phase without `loopback`: the only loopback ports the command may listen on and
   * connect to (the visual step's app server, AD-24). macOS opens just these ports of the host's
   * loopback; on Linux the verify phase has a private loopback of its own, so nothing changes.
   */
  readonly loopbackPorts?: readonly number[];
  /**
   * The run's dependency download caches (`GOMODCACHE`, Cargo's `registry` and `git`, and each
   * phase's `CARGO_HOME`), writable in both phases: what `go mod download` and `cargo fetch`
   * download in the install phase, the verify phase builds from (spine §5 reading 252). Their
   * extracted contents are hashed with the checkout (`GateCommandJail.downloadCaches`, reading
   * 253), so a change after the scripts-free fetch fails the verify gates.
   */
  readonly deps?: string;
}

/** A wrapped command that runs under {@link REAPER_SCRIPT} (see `exec.ts` `ExecRequest.reaper`). */
export interface ReapedGateCommand extends WrappedGateCommand {
  readonly reaper: true;
}

const isReaped = (wrapped: WrappedGateCommand): wrapped is ReapedGateCommand =>
  (wrapped as Partial<ReapedGateCommand>).reaper === true;

const extrasOf = (
  spec: GateSandboxSpec,
): {
  hideRead: readonly string[];
  allowRead: readonly string[];
  reapSentinel?: string;
  resolvConf?: string;
  loopbackPorts: readonly number[];
  deps?: string;
} => {
  const extra = spec as GateJailSpec;
  return {
    hideRead: extra.hideRead ?? [],
    allowRead: extra.allowRead ?? [],
    loopbackPorts: extra.loopbackPorts ?? [],
    ...(extra.deps === undefined ? {} : { deps: extra.deps }),
    ...(extra.reapSentinel === undefined ? {} : { reapSentinel: extra.reapSentinel }),
    ...(extra.resolvConf === undefined ? {} : { resolvConf: extra.resolvConf }),
  };
};

/**
 * The environment of a sandboxed gate: the scrubbed allowlist (`gateEnv`) without
 * {@link SANDBOX_DROPPED_ENV}, `HOME` (and `USERPROFILE`) at the run's empty home and the temp
 * variables at the command's private temp directory.
 */
export const sandboxEnv = (
  env: Readonly<Record<string, string>>,
  dirs: {
    readonly home: string;
    readonly tempDir: string;
    /** The run's Go module cache (`GOMODCACHE`), shared by both phases. */
    readonly goModCache?: string;
    /** The phase's own `CARGO_HOME`, whose registry is the run's shared one. */
    readonly cargoHome?: string;
  },
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SANDBOX_DROPPED_ENV.includes(key)) out[key] = value;
  }
  return {
    ...out,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    // the tools' user config, data and caches follow the phase's own home (reading 252)
    XDG_CONFIG_HOME: join(dirs.home, ".config"),
    XDG_CACHE_HOME: join(dirs.home, ".cache"),
    XDG_DATA_HOME: join(dirs.home, ".local", "share"),
    XDG_STATE_HOME: join(dirs.home, ".local", "state"),
    TMPDIR: dirs.tempDir,
    TMP: dirs.tempDir,
    TEMP: dirs.tempDir,
    ...(dirs.goModCache === undefined ? {} : { GOMODCACHE: dirs.goModCache }),
    ...(dirs.cargoHome === undefined ? {} : { CARGO_HOME: dirs.cargoHome }),
  };
};

const checkSpec = (argv: readonly string[], spec: GateSandboxSpec): void => {
  if (argv.length === 0 || argv[0] === "") throw new Error("gate sandbox: empty command");
  const extra = extrasOf(spec);
  for (const p of [
    spec.checkout,
    spec.tempDir,
    spec.home,
    ...(extra.deps === undefined ? [] : [extra.deps]),
    ...spec.denyRead,
    ...extra.hideRead,
    ...extra.allowRead,
    ...(extra.reapSentinel === undefined ? [] : [extra.reapSentinel]),
    ...(extra.resolvConf === undefined ? [] : [extra.resolvConf]),
  ]) {
    if (!isAbsolute(p)) throw new Error(`gate sandbox: expected an absolute path, got ${p}`);
  }
  for (const port of extra.loopbackPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`gate sandbox: not a loopback port: ${String(port)}`);
    }
  }
};

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The `-D` parameters of the writable directories (`DEPS` when the spec has {@link GateJailSpec.deps}). */
const WRITABLE = ["CHECKOUT", "TEMP", "HOME"] as const;

/**
 * The system services (mach-lookup global names) a gate command may reach on macOS; every other
 * service is refused by `(deny default)`. `always`: user and group lookups, logging,
 * notifications and the per-user directory helper. `install`: DNS, network configuration and
 * certificate trust, only where the network is. Never on either list: LaunchServices
 * (`com.apple.coreservices.launchservicesd`, `com.apple.lsd.*`), AppleEvents, `nsurlsessiond`,
 * the pasteboard and the keychain (`com.apple.SecurityServer`, `com.apple.securityd.xpc`), any of
 * which could have code run, or secrets read, outside the sandbox.
 */
export const GATE_MACH_SERVICES = {
  always: [
    "com.apple.system.opendirectoryd.libinfo",
    "com.apple.system.opendirectoryd.membership",
    "com.apple.system.notification_center",
    "com.apple.system.logger",
    "com.apple.logd",
    "com.apple.bsd.dirhelper",
  ],
  install: [
    "com.apple.dnssd.service",
    "com.apple.SystemConfiguration.configd",
    "com.apple.SystemConfiguration.DNSConfiguration",
    "com.apple.networkd",
    "com.apple.trustd",
    "com.apple.trustd.agent",
    "com.apple.ocspd",
  ],
} as const;

/** The read operations, spelled out: a rule for one operation beats a `file-read*` rule. */
const READ_OPS = "file-read-data file-read-metadata file-read-xattr";
/** Hidden: no contents or extended attributes, but names and metadata (so paths still resolve). */
const HIDE_OPS = "file-read-data file-read-xattr";

/**
 * The supervisor every macOS gate command runs under, inside its sandbox (`sh -c` with the
 * sentinel, then the gate's argv). It starts an anchor in its own process group (so the timeout's
 * process-group kill misses it) that waits for the jail to close the control pipe (stdin, moved
 * to fd 4) once the command has ended, then kills every process left in the sandbox with
 * `kill -KILL -1` (the profile lets a process signal only its own sandbox) and confirms with `R`
 * on fd 3 first. The command itself gets `/dev/null` as stdin and neither pipe. The anchor kills
 * only when it cannot read the sentinel, i.e. only inside the sandbox; unsandboxed it does
 * nothing and the jail reports the missing confirmation.
 */
export const REAPER_SCRIPT = [
  "s=$1; shift",
  "exec 4<&0 0</dev/null",
  "set -m",
  '{ read -r _ <&4; if [ -e "$s" ] && ! (: <"$s") 2>/dev/null; then printf R >&3; kill -KILL -1; fi; } >/dev/null 2>&1 &',
  "set +m",
  "exec 3>&- 4<&-",
  '"$@"',
].join("\n");

/**
 * The `sandbox-exec` profile for one command and its `-D` parameters. `resolve` maps a path to
 * its real path (the kernel checks real paths: `/tmp` is `/private/tmp` on macOS); a deny, hide
 * or read entry whose real path differs is listed under both spellings.
 *
 * Read rules, in order (for the same operations the last matching rule wins): every file is
 * readable; the hidden directories' contents are not; the readable roots inside them are again;
 * the writable directories are readable and writable; the deny list and the user's terminals are
 * not readable at all.
 */
export const sandboxExecProfile = (
  spec: GateJailSpec,
  resolve: (path: string) => string = realOrSelf,
): { readonly profile: string; readonly params: readonly (readonly [string, string])[] } => {
  const extra = extrasOf(spec);
  const params: [string, string][] = [
    ["CHECKOUT", resolve(spec.checkout)],
    ["TEMP", resolve(spec.tempDir)],
    ["HOME", resolve(spec.home)],
    ...(extra.deps === undefined ? [] : [["DEPS", resolve(extra.deps)] as [string, string]]),
  ];
  const keyed = (prefix: string, paths: readonly string[]): string[] => {
    const keys: string[] = [];
    for (const path of paths) {
      for (const p of new Set([path, resolve(path)])) {
        const key = `${prefix}_${String(keys.length)}`;
        keys.push(key);
        params.push([key, p]);
      }
    }
    return keys;
  };
  const hide = keyed("HIDE", extra.hideRead);
  const read = keyed("READ", extra.allowRead);
  const deny = keyed("DENY", spec.denyRead);
  const sentinel = extra.reapSentinel;
  if (sentinel !== undefined) params.push(["SENTINEL", sentinel]);
  const sub = (key: string): string => `(subpath (param "${key}"))`;
  const writableKeys = [...WRITABLE, ...(extra.deps === undefined ? [] : ["DEPS"])];
  const writable = writableKeys.map(sub).join(" ");
  const mach = [
    ...GATE_MACH_SERVICES.always,
    ...(spec.phase === "install" ? GATE_MACH_SERVICES.install : []),
  ];
  // One rule per path: a socket filter takes a single path filter, so rules are never combined.
  const unixSockets = writableKeys.flatMap((key) => [
    `(allow network-bind network-inbound (local unix-socket ${sub(key)}))`,
    `(allow network-outbound (remote unix-socket ${sub(key)}))`,
  ]);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork)",
    "(allow process-exec)",
    "(allow signal (target same-sandbox))",
    "(allow process-info* (target same-sandbox))",
    "(allow sysctl-read)",
    "(allow ipc-posix-sem)",
    `(allow mach-lookup ${mach.map((name) => `(global-name "${name}")`).join(" ")})`,
    "(allow file-read*)",
    ...hide.map((key) => `(deny ${HIDE_OPS} ${sub(key)})`),
    ...read.map((key) => `(allow ${READ_OPS} ${sub(key)})`),
    `(allow ${READ_OPS} file-write* ${writable})`,
    '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))',
    '(allow file-ioctl (literal "/dev/null") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom"))',
    ...deny.map((key) => `(deny file-read* ${READ_OPS} ${sub(key)})`),
    `(deny file-read* ${READ_OPS} (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))`,
    ...(sentinel === undefined ? [] : [`(deny ${HIDE_OPS} (literal (param "SENTINEL")))`]),
  ];
  if (spec.phase === "verify" && spec.loopback === true) {
    // D-av: the human said at calibration that the suite needs the loopback (gates.yml
    // `sandbox.verify_loopback`): sockets to 127.0.0.1 / ::1 only, never another host. The engine
    // token stays unreadable, so the engine API is still closed to the gate.
    lines.push(
      "(allow system-socket)",
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind network-inbound (local ip "localhost:*"))',
      ...unixSockets,
    );
  } else if (spec.phase === "verify" && extra.loopbackPorts.length > 0) {
    // The visual step's app server (AD-24): its own port of the host's loopback and no other, so
    // neither it nor the page reaches the engine API, a local database or a listener on another
    // port. A host service already on this very port would be reachable: the visual runner
    // refuses to start the app when something answers there (runner-script.ts).
    lines.push(
      "(allow system-socket)",
      ...[...new Set(extra.loopbackPorts)].flatMap((port) => [
        `(allow network-outbound (remote ip "localhost:${String(port)}"))`,
        `(allow network-bind network-inbound (local ip "localhost:${String(port)}"))`,
      ]),
      ...unixSockets,
    );
  } else if (spec.phase === "verify") {
    // No network at all; Unix sockets only inside the writable directories (test runners' IPC).
    lines.push("(allow system-socket (socket-domain AF_UNIX))", ...unixSockets);
  } else {
    // IP networking for the registries; of the Unix sockets only DNS and the writable directories
    // (never the engine socket, an ssh or gpg agent, or Docker). Never the host's loopback (the
    // engine API, the prototype origin, local databases): the deny follows the allow, so it wins,
    // as on Linux, where pasta maps no loopback.
    lines.push(
      "(allow system-socket)",
      "(allow network-outbound (remote ip))",
      '(deny network-outbound (remote ip "localhost:*"))',
      "(allow network-bind network-inbound (local ip))",
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
      ...unixSockets,
    );
  }
  return { profile: lines.join("\n"), params };
};

/**
 * `sandbox-exec` with a VTC-generated profile (macOS). With the jail's sentinel the command runs
 * under {@link REAPER_SCRIPT} and the result is a {@link ReapedGateCommand}.
 */
export const createSandboxExecSandbox = (
  options: { readonly binary?: string; readonly realpath?: (path: string) => string } = {},
): GateSandbox => ({
  kind: "sandbox-exec",
  wrap: (argv, spec): WrappedGateCommand | ReapedGateCommand => {
    checkSpec(argv, spec);
    const { profile, params } = sandboxExecProfile(spec, options.realpath);
    const sentinel = extrasOf(spec).reapSentinel;
    const head = ["-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "--"];
    const network = spec.phase === "verify" ? "none" : "full";
    const command = options.binary ?? SANDBOX_EXEC;
    if (sentinel === undefined) return { command, args: [...head, ...argv], network };
    return {
      command,
      args: [...head, "/bin/sh", "-c", REAPER_SCRIPT, "vtc-gate", sentinel, ...argv],
      network,
      reaper: true,
    };
  },
});

/** What bwrap needs to know about a path: whether it exists, and as what. */
export interface BwrapFs {
  readonly realpath: (path: string) => string;
  readonly kind: (path: string) => "dir" | "file" | null;
}

const hostFs: BwrapFs = {
  realpath: realOrSelf,
  kind: (path) => {
    try {
      return statSync(path).isDirectory() ? "dir" : "file";
    } catch {
      return null;
    }
  },
};

/**
 * The host directories a bwrap sandbox shows (read-only, when they exist): programs, libraries
 * and system configuration. Never `/home`, `/root`, `/run`, `/tmp`, `/var` or `/mnt`: the host's
 * IPC endpoints (the D-Bus session bus under `/run/user`, X11 under `/tmp/.X11-unix`,
 * `/var/run/docker.sock`, ssh and gpg agent sockets) live there, and a read-only bind does not
 * stop a `connect()` on a socket.
 */
export const BWRAP_SYSTEM_ROOTS: readonly string[] = [
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib32",
  "/lib64",
  "/libx32",
  "/etc",
  "/opt",
  "/nix",
  "/snap",
  "/sys",
];

interface Mount {
  readonly op: "--ro-bind" | "--bind" | "--symlink" | "--tmpfs";
  readonly src: string;
  readonly dest: string;
}

const depthOf = (path: string): number => path.split("/").filter((part) => part !== "").length;

/**
 * The `bwrap` arguments (before the gate's argv) for one command: new PID, IPC and UTS
 * namespaces, its own network namespace in the verify phase (the install phase's argv runs inside
 * the namespace pasta creates, see {@link createBwrapSandbox}), and a minimal root:
 * {@link BWRAP_SYSTEM_ROOTS} read-only (a symlinked one, like merged-`/usr` `/bin`, stays a
 * link), a fresh `/tmp`, the readable roots read-only, an empty tmpfs over each hidden directory
 * a bound root would show, and the checkout, home and temp directory writable; mounts go
 * shallowest first, so a deeper one is never covered. The install phase also gets a resolver at the
 * file `/etc/resolv.conf` points to: the jail's `resolvConf` when there is one, else the host's
 * file. Last, every visible denied path is hidden (an empty read-only
 * tmpfs over a directory, `/dev/null` over a file). Paths that do not exist are skipped: there is
 * nothing to read, and bwrap cannot mount over them.
 */
export const bwrapArgs = (
  argv: readonly string[],
  spec: GateJailSpec,
  fs: BwrapFs = hostFs,
): string[] => {
  const extra = extrasOf(spec);
  const mounts: Mount[] = [{ op: "--tmpfs", src: "", dest: "/tmp" }];
  const add = (mount: Mount): void => {
    if (!mounts.some((m) => m.op === mount.op && m.dest === mount.dest)) mounts.push(mount);
  };
  const readOnly = (path: string): void => {
    if (fs.kind(path) === null) return;
    const real = fs.realpath(path);
    add({ op: "--ro-bind", src: real, dest: real });
    if (real !== path) add({ op: "--ro-bind", src: real, dest: path });
  };
  for (const root of BWRAP_SYSTEM_ROOTS) {
    if (fs.kind(root) === null) continue;
    const real = fs.realpath(root);
    add(
      real === root
        ? { op: "--ro-bind", src: root, dest: root }
        : { op: "--symlink", src: real, dest: root },
    );
  }
  const binds = (): string[] =>
    mounts.filter((m) => m.op === "--ro-bind" || m.op === "--bind").map((m) => m.dest);
  const visible = (path: string): boolean => binds().some((dest) => within(path, dest));
  if (spec.phase === "install" && fs.kind("/etc/resolv.conf") !== null) {
    const resolv = fs.realpath("/etc/resolv.conf");
    if (extra.resolvConf !== undefined) {
      add({ op: "--ro-bind", src: extra.resolvConf, dest: resolv });
    } else if (!visible(resolv)) {
      add({ op: "--ro-bind", src: resolv, dest: resolv });
    }
  }
  for (const path of extra.allowRead) readOnly(path);
  for (const dir of [
    spec.checkout,
    spec.home,
    spec.tempDir,
    ...(extra.deps === undefined ? [] : [extra.deps]),
  ]) {
    const real = fs.realpath(dir);
    add({ op: "--bind", src: real, dest: real });
  }
  for (const path of extra.hideRead) {
    if (fs.kind(path) === null) continue;
    const real = fs.realpath(path);
    if (visible(real)) add({ op: "--tmpfs", src: "", dest: real });
  }
  const ordered = mounts
    .map((mount, index) => ({ mount, index }))
    .sort((a, b) => depthOf(a.mount.dest) - depthOf(b.mount.dest) || a.index - b.index)
    .map(({ mount }) => mount);
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(spec.phase === "verify" ? ["--unshare-net"] : []),
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  for (const m of ordered) {
    if (m.op === "--tmpfs") args.push("--tmpfs", m.dest);
    else args.push(m.op, m.src, m.dest);
  }
  const seen = new Set<string>();
  for (const path of spec.denyRead) {
    const kind = fs.kind(path);
    if (kind === null) continue;
    const real = fs.realpath(path);
    if (seen.has(real) || !visible(real)) continue;
    seen.add(real);
    if (kind === "dir") args.push("--tmpfs", real, "--remount-ro", real);
    else args.push("--ro-bind", "/dev/null", real);
  }
  return [...args, "--", ...argv];
};

/** The address pasta forwards DNS queries from (to the host's first resolver). */
export const PASTA_DNS_FORWARD = "169.254.1.1";

/** The jail's `resolv.conf` for the Linux install phase: pasta's DNS forwarder only. */
export const PASTA_RESOLV_CONF = `nameserver ${PASTA_DNS_FORWARD}\n`;

/**
 * The `pasta` options of a Linux install-phase command: a new user and network namespace with
 * its interface configured from the host's (`--config-net`), in the foreground, quiet, with no
 * port forwarding in either direction (`-t`/`-u` host to namespace, `-T`/`-U` namespace to host,
 * whose `auto` default would mirror the host's loopback listeners, the engine among them), the
 * gateway never mapped to the host's loopback (`--no-map-gw`), and DNS forwarded from
 * {@link PASTA_DNS_FORWARD}.
 */
export const PASTA_ARGS: readonly string[] = [
  "--config-net",
  "--foreground",
  "--quiet",
  "-t",
  "none",
  "-u",
  "none",
  "-T",
  "none",
  "-U",
  "none",
  "--no-map-gw",
  "--dns-forward",
  PASTA_DNS_FORWARD,
];

/**
 * Why a Linux install-phase gate does not run (D-aw, spine §5 reading 85): without pasta it would
 * share the host's network namespace, loopback included. Verify-phase gates need no pasta.
 */
export const PASTA_MISSING_INSTALL =
  "pasta (passt) is not installed or cannot start here, so install-phase gates cannot run in a network namespace of their own; install passt (verify-phase gates run without it)";

/**
 * `bwrap` (Linux), never in the host's network namespace: the verify phase in bwrap's own, the
 * install phase in pasta's (`pasta {@link PASTA_ARGS} -- bwrap …`). Inside pasta's user
 * namespace the caller is root, so bwrap starts a nested user namespace with the real `uid` and
 * `gid` (package managers act differently as root). An install-phase command needs the jail's
 * `resolvConf`.
 */
export const createBwrapSandbox = (
  options: {
    readonly binary: string;
    /** Absent (D-aw): verify-phase commands still run; install-phase ones refuse. */
    readonly pasta?: string;
    readonly uid?: number;
    readonly gid?: number;
  } & Partial<BwrapFs>,
): GateSandbox => {
  const fs: BwrapFs = {
    realpath: options.realpath ?? hostFs.realpath,
    kind: options.kind ?? hostFs.kind,
  };
  const uid = String(options.uid ?? process.getuid?.() ?? 0);
  const gid = String(options.gid ?? process.getgid?.() ?? 0);
  return {
    kind: "bwrap",
    wrap: (argv, spec): WrappedGateCommand => {
      checkSpec(argv, spec);
      if (spec.phase === "verify") {
        return { command: options.binary, args: bwrapArgs(argv, spec, fs), network: "none" };
      }
      if (options.pasta === undefined) throw new Error(PASTA_MISSING_INSTALL);
      if (extrasOf(spec).resolvConf === undefined) {
        throw new Error("gate sandbox: an install-phase command needs the jail's resolv.conf");
      }
      return {
        command: options.pasta,
        args: [
          ...PASTA_ARGS,
          "--",
          options.binary,
          "--unshare-user",
          "--uid",
          uid,
          "--gid",
          gid,
          ...bwrapArgs(argv, spec, fs),
        ],
        network: "full",
      };
    },
  };
};

/**
 * No sandbox: the argv as it is, with the full network. Used only under the user-level
 * `gates.allow_unsandboxed` opt-in; the environment rules (empty `HOME`, no `VTC_HOME`) still
 * apply.
 */
export const UNSANDBOXED: GateSandbox = {
  kind: "none",
  wrap: (argv): WrappedGateCommand => {
    if (argv.length === 0 || argv[0] === "") throw new Error("gate sandbox: empty command");
    return { command: argv[0] ?? "", args: argv.slice(1), network: "full" };
  },
};

/**
 * The sandbox gate commands run in: the injected one, else the detected one, else
 * {@link UNSANDBOXED} under the user-level opt-in, else `null` (nothing runs).
 */
export const resolveGateSandbox = (
  deps: { readonly sandbox?: GateSandbox; readonly allowUnsandboxed?: boolean },
  detect: () => GateSandbox | null = () => detectGateSandbox().sandbox,
): GateSandbox | null => {
  const found = deps.sandbox ?? detect();
  if (found !== null) return found;
  return deps.allowUnsandboxed === true ? UNSANDBOXED : null;
};

export interface GateSandboxDetection {
  /** The sandbox gate commands run in on this machine, or `null` when there is none. */
  readonly kind: Exclude<GateSandboxKind, "none"> | null;
  readonly sandbox: GateSandbox | null;
  /** One line for `vtc doctor`: the tool in use, or `GATE_SANDBOX.noSandboxReason` and why. */
  readonly detail: string;
  /** With no sandbox: why there is none (the middle of `detail`, for callers that word the rest). */
  readonly reason?: string;
  /** With a sandbox that cannot run every phase (Linux without pasta, D-aw): what does not run. */
  readonly warning?: string;
}

export interface DetectGateSandboxOptions {
  readonly platform?: NodeJS.Platform;
  /** The environment whose `PATH` is searched for `bwrap` and `pasta` (absolute entries only). */
  readonly env?: Env;
  readonly exists?: (path: string) => boolean;
  /** Runs a no-op command in the sandbox; true when it exits 0. */
  readonly probe?: (argv: readonly string[]) => boolean;
}

const defaultProbe = (argv: readonly string[]): boolean => {
  const [command, ...args] = argv;
  if (command === undefined) return false;
  const result = spawnSync(command, args, { stdio: "ignore", shell: false, timeout: 10_000 });
  return result.status === 0;
};

const NO_SANDBOX_HINT =
  "gates do not run; set gates.allow_unsandboxed: true in ~/.vtc/config.yaml to run them unconfined (an incident is recorded for every such gate run)";

/**
 * The OS sandbox this machine offers gate commands, checked with a short no-op run (it fails when
 * user namespaces are disabled, or when VTC itself already runs inside a sandbox that forbids
 * nesting). Never throws. Exported for `vtc doctor`.
 */
export const detectGateSandbox = (options: DetectGateSandboxOptions = {}): GateSandboxDetection => {
  const platform = options.platform ?? process.platform;
  const exists = options.exists ?? existsSync;
  const probe = options.probe ?? defaultProbe;
  const none = (why: string): GateSandboxDetection => ({
    kind: null,
    sandbox: null,
    detail: `${GATE_SANDBOX.noSandboxReason}: ${why}; ${NO_SANDBOX_HINT}`,
    reason: why,
  });
  try {
    if (platform === "darwin") {
      if (!exists(SANDBOX_EXEC)) return none(`${SANDBOX_EXEC} is missing`);
      if (!probe([SANDBOX_EXEC, "-p", "(version 1)(allow default)", "--", "/usr/bin/true"])) {
        return none(`${SANDBOX_EXEC} cannot start a sandbox here`);
      }
      return {
        kind: "sandbox-exec",
        sandbox: createSandboxExecSandbox(),
        detail: `sandbox-exec (${SANDBOX_EXEC}, VTC-generated profile)`,
      };
    }
    if (platform === "linux") {
      const path = (options.env ?? process.env).PATH ?? "";
      const candidates = [
        ...path.split(delimiter).filter((d) => d !== "" && isAbsolute(d)),
        "/usr/bin",
      ];
      const found = (name: string): string | undefined =>
        candidates.map((d) => join(d, name)).find((c) => exists(c));
      const binary = found("bwrap");
      if (binary === undefined) return none("bwrap (bubblewrap) is not installed");
      const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc"];
      if (
        !probe([
          binary,
          ...args,
          "--unshare-pid",
          "--unshare-net",
          "--die-with-parent",
          "--",
          "true",
        ])
      ) {
        return none(
          `${binary} cannot create namespaces here (are unprivileged user namespaces disabled?)`,
        );
      }
      const pasta = found("pasta");
      // D-aw: without a working pasta only install-phase gates are refused; verify ones run
      const withoutPasta = (): GateSandboxDetection => ({
        kind: "bwrap",
        sandbox: createBwrapSandbox({ binary }),
        detail: `bwrap (${binary}, own network namespace; no pasta, so install-phase gates do not run)`,
        warning: PASTA_MISSING_INSTALL,
      });
      if (pasta === undefined) return withoutPasta();
      if (
        !probe([
          pasta,
          ...PASTA_ARGS,
          "--",
          binary,
          "--unshare-user",
          ...args,
          "--unshare-pid",
          "--die-with-parent",
          "--",
          "true",
        ])
      ) {
        return withoutPasta();
      }
      return {
        kind: "bwrap",
        sandbox: createBwrapSandbox({ binary, pasta }),
        detail: `bwrap (${binary}, own network namespace; install phase through pasta, ${pasta})`,
      };
    }
    return none(`no gate sandbox is implemented for ${platform}`);
  } catch (error) {
    return none(error instanceof Error ? error.message : String(error));
  }
};

/** One sandboxed command: where it runs, in which phase, with what. */
export interface JailedRequest extends ExecRequest {
  readonly phase: GatePhase;
  /** Verify phase: the loopback is reachable (gates.yml `sandbox.verify_loopback`, D-av). */
  readonly loopback?: boolean;
  /** Verify phase: only these loopback ports are reachable ({@link GateJailSpec.loopbackPorts}). */
  readonly loopbackPorts?: readonly number[];
  /** Absolute checkout the command may write. */
  readonly checkout: string;
  /**
   * Absolute directories this command may read besides the run's readable roots (the visual
   * runner's browser store or Playwright cache, AD-24). The deny list still wins.
   */
  readonly allowRead?: readonly string[];
  /**
   * Called with the command's fresh private temp directory before it starts (the visual runner
   * writes its script and input there, AD-24 rule 1). Every `{tmp}` in `argv` becomes that
   * directory.
   */
  readonly setup?: (tempDir: string) => void;
}

export interface JailedResult extends ExecResult {
  /** The command's private temp directory; removed with the jail ({@link GateCommandJail.dispose}). */
  readonly tempDir: string;
  readonly network: WrappedGateCommand["network"];
  /**
   * Set when processes the command left may still be running: the in-sandbox reaper did not
   * confirm it stopped them (the command may have killed it). The jail then runs nothing more.
   */
  readonly leftover?: string;
}

/** Why a jail refuses to run anything after a reaper did not confirm. */
export const REAPER_UNCONFIRMED =
  "the gate sandbox's reaper did not confirm that it stopped every process the command left behind (the command may have killed it), so no further gate command runs in this run";

/**
 * A phase's `CARGO_HOME` in `deps`, made afresh (whatever was there is removed first: the install
 * phase can write `deps`): empty but for links to the run's shared `registry` and `git`
 * downloads, so Cargo's own config (`config.toml`, `credentials.toml`) is never shared between
 * the phases (spine §5 reading 252).
 */
const freshCargoHome = (deps: string, phase: GatePhase): void => {
  const dir = join(deps, `cargo-${phase}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { mode: 0o700 });
  symlinkSync("../cargo-registry", join(dir, "registry"));
  symlinkSync("../cargo-git", join(dir, "git"));
};

/**
 * The per-run side of the sandbox: one private temp root (mode 0700) holding each phase's empty
 * `HOME`, the dependency download caches, the reaper's sentinel and a fresh temp directory per
 * command, removed by
 * {@link dispose}. Wraps and runs each command with the run's read policy; `ran` says whether any
 * command started (a report then names the sandbox).
 */
export class GateCommandJail {
  private root: string | null = null;
  private home = "";
  private verifyHome: string | null = null;
  private sentinel = "";
  private resolvConf = "";
  private count = 0;
  private broken: string | null = null;
  ran = false;

  constructor(
    readonly sandbox: GateSandbox,
    private readonly denyRead: readonly string[],
    private readonly read: Pick<Partial<GateReadPolicy>, "hideRead" | "allowRead"> = {},
  ) {}

  get kind(): GateSandboxKind {
    return this.sandbox.kind;
  }

  /**
   * The run's private root (created on first use, mode 0700): the install phase's empty `HOME`,
   * the reaper's sentinel, the install phase's `resolv.conf`, the dependency download caches
   * (`deps`) and, once the verify phase starts, its own empty `HOME`.
   */
  private rootDir(): string {
    if (this.root === null) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "vtc-gate-")));
      chmodSync(root, 0o700);
      this.root = root;
      this.home = join(root, "home");
      mkdirSync(this.home, { mode: 0o700 });
      this.sentinel = join(root, "sandboxed");
      writeFileSync(this.sentinel, "", { mode: 0o600 });
      this.resolvConf = join(root, "resolv.conf");
      writeFileSync(this.resolvConf, PASTA_RESOLV_CONF, { mode: 0o644 });
      const deps = join(root, "deps");
      for (const dir of ["", "go-mod", "cargo-registry", "cargo-git"]) {
        mkdirSync(join(deps, dir), { mode: 0o700 });
      }
      freshCargoHome(deps, "install");
    }
    return this.root;
  }

  /**
   * The phase's empty `HOME` (created on first use). The install phase and the verify phase never
   * share one (spine §5 reading 252): user-level config an install script writes there
   * (`~/.npmrc` `script-shell` or `node-options`, `~/.yarnrc.yml`, `~/.bunfig.toml`, a Python
   * `usercustomize.py`, `~/.cargo/config.toml`) never reaches a verify gate. The verify phase's
   * home is made when its first command runs, in the run's private root, where no install command
   * can write; its `CARGO_HOME` is made afresh then too.
   */
  homeDir(phase: GatePhase = "install"): string {
    const root = this.rootDir();
    if (phase === "install") return this.home;
    if (this.verifyHome === null) {
      const home = join(root, "home-verify");
      mkdirSync(home, { mode: 0o700 });
      freshCargoHome(join(root, "deps"), "verify");
      this.verifyHome = home;
    }
    return this.verifyHome;
  }

  /**
   * The directories gate commands can write besides the checkout (spine §5 reading 253): the
   * run's private root (each phase's home, the temp directories and the download caches), or
   * everything when commands run unsandboxed. A link of the checkout into one of them fails the
   * run's verify gates (`workspaceTree`).
   */
  writableRoots(): string[] {
    return this.sandbox.kind === "none" ? ["/"] : [this.rootDir()];
  }

  /**
   * The download caches verify gates build from (spine §5 reading 253), hashed with the checkout:
   * Go's module cache without its own download cache (`cache/`: zips, lock files), Cargo's
   * extracted registry sources and its git checkouts.
   */
  downloadCaches(): { label: string; dir: string; skip?: string[] }[] {
    const deps = join(this.rootDir(), "deps");
    return [
      { label: "go-mod", dir: join(deps, "go-mod"), skip: ["cache"] },
      { label: "cargo-registry/src", dir: join(deps, "cargo-registry", "src") },
      { label: "cargo-git/checkouts", dir: join(deps, "cargo-git", "checkouts") },
    ];
  }

  private dirs(phase: GatePhase): {
    home: string;
    tempDir: string;
    deps: string;
    goModCache: string;
    cargoHome: string;
  } {
    const home = this.homeDir(phase);
    const root = this.rootDir();
    const tempDir = join(root, `tmp-${String(this.count)}`);
    this.count += 1;
    mkdirSync(tempDir, { mode: 0o700 });
    const deps = join(root, "deps");
    return {
      home,
      tempDir,
      deps,
      goModCache: join(deps, "go-mod"),
      cargoHome: join(deps, `cargo-${phase}`),
    };
  }

  async run(jailed: JailedRequest): Promise<JailedResult> {
    if (this.broken !== null) throw new Error(this.broken);
    const { home, tempDir, deps, goModCache, cargoHome } = this.dirs(jailed.phase);
    const { allowRead: extraRead, setup, loopbackPorts, ...rest } = jailed;
    setup?.(tempDir);
    const request = {
      ...rest,
      argv: setup === undefined ? rest.argv : rest.argv.map((t) => t.replaceAll("{tmp}", tempDir)),
    };
    const spec: GateJailSpec = {
      phase: request.phase,
      checkout: realOrSelf(request.checkout),
      tempDir,
      home,
      deps,
      denyRead: this.denyRead,
      hideRead: this.read.hideRead ?? [],
      allowRead: [...(this.read.allowRead ?? []), ...(extraRead ?? []).map(realOrSelf)],
      reapSentinel: this.sentinel,
      resolvConf: this.resolvConf,
      ...(request.loopback === true && request.phase === "verify" ? { loopback: true } : {}),
      ...(loopbackPorts !== undefined && loopbackPorts.length > 0 && request.phase === "verify"
        ? { loopbackPorts }
        : {}),
    };
    const wrapped = this.sandbox.wrap(request.argv, spec);
    const reaper = isReaped(wrapped);
    this.ran = true;
    const result = await runCommand({
      ...request,
      argv: [wrapped.command, ...wrapped.args],
      env: sandboxEnv(request.env, { home, tempDir, goModCache, cargoHome }),
      ...(reaper ? { reaper: true } : {}),
    });
    if (reaper && result.spawnError === undefined && result.reaped !== true) {
      this.broken = REAPER_UNCONFIRMED;
      return { ...result, tempDir, network: wrapped.network, leftover: REAPER_UNCONFIRMED };
    }
    return { ...result, tempDir, network: wrapped.network };
  }

  /**
   * Removes one command's temp directory (`JailedResult.tempDir`) once its caller has read back
   * what it needs, so no later command of the run can read it (never throws). Anything else is
   * left alone.
   */
  removeTempDir(tempDir: string): void {
    if (this.root === null || dirname(tempDir) !== this.root) return;
    if (!/^tmp-\d+$/.test(basename(tempDir))) return;
    try {
      if (lstatSync(tempDir).isSymbolicLink()) return;
      makeWritable(tempDir);
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best effort: dispose() removes the whole run
    }
  }

  /** Removes the run's home and temp directories (never throws). */
  dispose(): void {
    if (this.root === null) return;
    try {
      // A gate may leave read-only directories behind (Go's module cache does).
      makeWritable(this.root);
      rmSync(this.root, { recursive: true, force: true });
    } catch {
      // best effort: the OS temp directory is cleaned eventually
    }
    this.root = null;
  }
}

const makeWritable = (dir: string): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !lstatSync(path).isSymbolicLink()) {
      chmodSync(path, 0o700);
      makeWritable(path);
    }
  }
};
