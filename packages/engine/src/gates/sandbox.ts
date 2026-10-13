/**
 * The gate sandbox (D-al, spine §5 reading 69, AD-13 rule 11; spec §7.2 two-phase sandbox). Every
 * command the Gate Runner starts (calibration, L0–L5, guards, Final Review, the OSV database
 * download) runs through a {@link GateSandbox}:
 *
 * - macOS: `/usr/bin/sandbox-exec` with a profile generated here ({@link sandboxExecProfile}).
 *   Paths reach the profile as `-D` parameters, never spliced into its text.
 * - Linux: `bwrap` ({@link bwrapArgs}): the host root read-only, the checkout and the private temp
 *   directories bound writable, denied paths hidden, and its own network namespace in the verify
 *   phase (a private loopback only).
 *
 * Rules, the same in both: the verify phase has no network; the install phase gets the full
 * network (neither tool can filter by registry host, so `WrappedGateCommand.network` says
 * `full`) with the same filesystem rules; writes only to the checkout, the command's private temp
 * directory and the run's empty `HOME`; reads denied on {@link gateDenyReadPaths} (the VTC home
 * except the scanners, rules and OSV database the gates run with, the host config directories,
 * the host credential files and common credential stores). The environment is the allowlist of
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
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  GATE_SANDBOX,
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
 * VTC's Opengrep rules (`rules.ts` `RULES_DIR`) and the OSV offline database (`osv-db.ts`
 * `OSV_DB_DIR`). Everything else there is read-denied. Spelled out here (a test keeps them equal)
 * so this module imports none of the three.
 */
export const GATE_READABLE_VTC_HOME: readonly string[] = ["scanners", "rules", "osv-db"];

/**
 * Credential stores under the user's home that no gate needs: SSH and cloud keys, registry and git
 * credentials, the Docker and Kubernetes configs, the user's keychains and Claude Code's own
 * config file. Never opened; only written into deny rules.
 */
export const HOME_CREDENTIAL_LOCATIONS: readonly string[] = [
  ".ssh",
  ".aws",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".config/git/credentials",
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".docker",
  ".kube",
  ".gnupg",
  ".claude.json",
  "Library/Keychains",
];

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
 * The environment of a sandboxed gate: the scrubbed allowlist (`gateEnv`) without
 * {@link SANDBOX_DROPPED_ENV}, `HOME` (and `USERPROFILE`) at the run's empty home and the temp
 * variables at the command's private temp directory.
 */
export const sandboxEnv = (
  env: Readonly<Record<string, string>>,
  dirs: { readonly home: string; readonly tempDir: string },
): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (!SANDBOX_DROPPED_ENV.includes(key)) out[key] = value;
  }
  return {
    ...out,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    TMPDIR: dirs.tempDir,
    TMP: dirs.tempDir,
    TEMP: dirs.tempDir,
  };
};

const checkSpec = (argv: readonly string[], spec: GateSandboxSpec): void => {
  if (argv.length === 0 || argv[0] === "") throw new Error("gate sandbox: empty command");
  for (const p of [spec.checkout, spec.tempDir, spec.home, ...spec.denyRead]) {
    if (!isAbsolute(p)) throw new Error(`gate sandbox: expected an absolute path, got ${p}`);
  }
};

const realOrSelf = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

/** The `-D` parameters of the writable directories. */
const WRITABLE = ["CHECKOUT", "TEMP", "HOME"] as const;

/** Mach services of the user's keychain (macOS reads keychain items through them, not files). */
const KEYCHAIN_SERVICES = ["com.apple.SecurityServer", "com.apple.securityd.xpc"];

/**
 * The `sandbox-exec` profile for one command and its `-D` parameters. `resolve` maps a path to
 * its real path (the kernel checks real paths: `/tmp` is `/private/tmp` on macOS); a deny entry
 * whose real path differs is denied under both spellings.
 */
export const sandboxExecProfile = (
  spec: GateSandboxSpec,
  resolve: (path: string) => string = realOrSelf,
): { readonly profile: string; readonly params: readonly (readonly [string, string])[] } => {
  const params: [string, string][] = [
    ["CHECKOUT", resolve(spec.checkout)],
    ["TEMP", resolve(spec.tempDir)],
    ["HOME", resolve(spec.home)],
  ];
  const deny: string[] = [];
  for (const path of spec.denyRead) {
    for (const p of new Set([path, resolve(path)])) {
      const key = `DENY_${String(deny.length)}`;
      deny.push(key);
      params.push([key, p]);
    }
  }
  const writable = WRITABLE.map((key) => `(subpath (param "${key}"))`).join(" ");
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* ${writable} (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$") (subpath "/dev/fd"))`,
    `(deny mach-lookup ${KEYCHAIN_SERVICES.map((s) => `(global-name "${s}")`).join(" ")})`,
  ];
  // One rule per path: a socket filter takes a single path filter, so rules are never combined.
  for (const key of deny) lines.push(`(deny file-read* (subpath (param "${key}")))`);
  if (spec.phase === "verify") {
    // No network at all; Unix sockets only inside the writable directories (test runners' IPC).
    lines.push("(deny network*)");
    for (const key of WRITABLE) {
      lines.push(
        `(allow network-bind network-inbound (local unix-socket (subpath (param "${key}"))))`,
        `(allow network-outbound (remote unix-socket (subpath (param "${key}"))))`,
      );
    }
  }
  return { profile: lines.join("\n"), params };
};

/** `sandbox-exec` with a VTC-generated profile (macOS). */
export const createSandboxExecSandbox = (
  options: { readonly binary?: string; readonly realpath?: (path: string) => string } = {},
): GateSandbox => ({
  kind: "sandbox-exec",
  wrap: (argv, spec): WrappedGateCommand => {
    checkSpec(argv, spec);
    const { profile, params } = sandboxExecProfile(spec, options.realpath);
    return {
      command: options.binary ?? SANDBOX_EXEC,
      args: ["-p", profile, ...params.flatMap(([k, v]) => ["-D", `${k}=${v}`]), "--", ...argv],
      network: spec.phase === "verify" ? "none" : "full",
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
 * The `bwrap` arguments (before the gate's argv) for one command: new PID, IPC and UTS
 * namespaces, its own network namespace in the verify phase, the host root read-only, the
 * checkout, home and temp directory writable, then every existing denied path hidden (an empty
 * read-only tmpfs over a directory, `/dev/null` over a file). Missing denied paths are skipped:
 * there is nothing to read, and bwrap cannot mount over a path that does not exist.
 */
export const bwrapArgs = (
  argv: readonly string[],
  spec: GateSandboxSpec,
  fs: BwrapFs = hostFs,
): string[] => {
  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    ...(spec.phase === "verify" ? ["--unshare-net"] : []),
    "--ro-bind",
    "/",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];
  for (const dir of [spec.checkout, spec.home, spec.tempDir]) {
    const real = fs.realpath(dir);
    args.push("--bind", real, real);
  }
  const seen = new Set<string>();
  for (const path of spec.denyRead) {
    const kind = fs.kind(path);
    if (kind === null) continue;
    const real = fs.realpath(path);
    if (seen.has(real)) continue;
    seen.add(real);
    if (kind === "dir") args.push("--tmpfs", real, "--remount-ro", real);
    else args.push("--ro-bind", "/dev/null", real);
  }
  return [...args, "--", ...argv];
};

/** `bwrap` with its own network namespace in the verify phase (Linux). */
export const createBwrapSandbox = (
  options: { readonly binary: string } & Partial<BwrapFs>,
): GateSandbox => {
  const fs: BwrapFs = {
    realpath: options.realpath ?? hostFs.realpath,
    kind: options.kind ?? hostFs.kind,
  };
  return {
    kind: "bwrap",
    wrap: (argv, spec): WrappedGateCommand => {
      checkSpec(argv, spec);
      return {
        command: options.binary,
        args: bwrapArgs(argv, spec, fs),
        network: spec.phase === "verify" ? "none" : "full",
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
}

export interface DetectGateSandboxOptions {
  readonly platform?: NodeJS.Platform;
  /** The environment whose `PATH` is searched for `bwrap` (absolute entries only). */
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
      ].map((d) => join(d, "bwrap"));
      const binary = candidates.find((c) => exists(c));
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
      return {
        kind: "bwrap",
        sandbox: createBwrapSandbox({ binary }),
        detail: `bwrap (${binary}, own network namespace in the verify phase)`,
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
  /** Absolute checkout the command may write. */
  readonly checkout: string;
}

export interface JailedResult extends ExecResult {
  readonly network: WrappedGateCommand["network"];
}

/**
 * The per-run side of the sandbox: one private temp root (mode 0700) holding the run's empty
 * `HOME` and a fresh temp directory per command, removed by {@link dispose}. Wraps and runs each
 * command; `ran` says whether any command started (a report then names the sandbox).
 */
export class GateCommandJail {
  private root: string | null = null;
  private home = "";
  private count = 0;
  ran = false;

  constructor(
    readonly sandbox: GateSandbox,
    private readonly denyRead: readonly string[],
  ) {}

  get kind(): GateSandboxKind {
    return this.sandbox.kind;
  }

  /** The run's empty `HOME` (created on first use); writable by every command of the run. */
  homeDir(): string {
    if (this.root === null) {
      const root = realpathSync(mkdtempSync(join(tmpdir(), "vtc-gate-")));
      chmodSync(root, 0o700);
      this.root = root;
      this.home = join(root, "home");
      mkdirSync(this.home, { mode: 0o700 });
    }
    return this.home;
  }

  private dirs(): { home: string; tempDir: string } {
    const home = this.homeDir();
    const tempDir = join(this.root ?? home, `tmp-${String(this.count)}`);
    this.count += 1;
    mkdirSync(tempDir, { mode: 0o700 });
    return { home, tempDir };
  }

  async run(request: JailedRequest): Promise<JailedResult> {
    const { home, tempDir } = this.dirs();
    const wrapped = this.sandbox.wrap(request.argv, {
      phase: request.phase,
      checkout: realOrSelf(request.checkout),
      tempDir,
      home,
      denyRead: this.denyRead,
    });
    this.ran = true;
    const result = await runCommand({
      ...request,
      argv: [wrapped.command, ...wrapped.args],
      env: sandboxEnv(request.env, { home, tempDir }),
    });
    return { ...result, network: wrapped.network };
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
