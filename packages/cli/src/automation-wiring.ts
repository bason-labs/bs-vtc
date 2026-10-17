/**
 * The cli's half of automatic issues and PRs (spine AD-27 rule 7, readings 194, 196, 201 and 207;
 * owner: cli+binary team): the user-level settings of `~/.vtc/config.yaml` (`upstream.repo`,
 * `upstream.share`, `upstream.checkout`, `automation.evidence_hosting`), what this machine allows
 * (`gh --version`, the origin remote, ffmpeg), and the two dependencies the daemon takes from the
 * cli: `EngineDeps.automation` ({@link buildAutomationDeps}) and `EngineDeps.armPlugins`
 * ({@link armPluginCompiler}). The project's own settings (`project.yaml` `upstream.share`,
 * `automation.*`) are not read here: the engine reads them at the run's commit.
 *
 * The login is checked only through `gh auth status`'s exit code (AD-27 rule 1): nothing it prints
 * is kept, and no token is ever read. The daemon asks through `AutomationDeps.ghLogin`
 * ({@link ghLoginProbe}) when it starts and then periodically (D-bz).
 *
 * The user's settings are read live (AD-27 rule 5): `upstream.share` is an opt-out the engine
 * checks when an item is queued and again when it is sent, and the daemon runs for long, so each
 * read of `AutomationDeps.upstream` (and `hosting`) goes back to `~/.vtc/config.yaml`
 * (`liveUserConfig`, re-read only when the file changed).
 *
 * The engine seams (readings 207 and 209): `git.createGitPlumbing` (engine core), the gate runner's
 * `gates.createEvidenceRecorder` and the compiler's `createArmPluginCompiler` (roles-compiler), all
 * landed in the round-4 merge. {@link shippedAutomationFactories} and
 * {@link shippedArmPluginCompilerFactory} look each one up by its export name and leave it out
 * while it is missing; {@link ShippedSeamsFit} checks at compile time that each export fits its
 * frozen seam type, so a changed signature fails the build, and the seam tests require all three.
 * Without a recorder no automatic PR opens (issues still do; `vtc doctor`'s `evidence` line says
 * so); without the arm compiler a replay on a Claude-led run waits for the next RETRO (`vtc
 * lookback approve` warns).
 */
import { join } from "node:path";
import * as compiler from "@vtc/compiler";
import { gates, git } from "@vtc/engine";
import {
  DEFAULT_UPSTREAM_REPO,
  EVIDENCE_HOSTING_DEFAULT,
  EVIDENCE_HOSTING_PREFERRED,
  GH_ATTACH_MIN_VERSION,
  type ArmPluginCompiler,
  type AutomationDeps,
  type BeforeAfterResult,
  type CreateGitPlumbing,
  type EvidenceHosting,
  type EvidenceRecorder,
  type GateRunnerDeps,
  type HostId,
} from "@vtc/shared";
import { versionAtLeast } from "./doctor-checks.js";
import { isGithubUrl } from "./gh-remote-merge.js";
import type { Exec } from "./process.js";
import type { UserConfigRead } from "./user-config.js";

// ------------------------------------------------------------------ settings

/**
 * `~/.vtc/config.yaml` `upstream` with its defaults (D-bz, D-by): `bason-labs/bs-vtc`
 * (`DEFAULT_UPSTREAM_REPO`), sharing on, no checkout (upstream issues only). A file that does not
 * parse turns sharing off: it may be the file in which the user switched it off (privacy fails
 * closed; `vtc doctor` reports the parse error).
 */
export const upstreamSettingsOf = (read: UserConfigRead): AutomationDeps["upstream"] => {
  if (!read.ok) return { repo: DEFAULT_UPSTREAM_REPO, share: false };
  const upstream = read.config.upstream;
  return {
    repo: upstream?.repo ?? DEFAULT_UPSTREAM_REPO,
    share: upstream?.share ?? true,
    ...(upstream?.checkout === undefined ? {} : { checkout: upstream.checkout }),
  };
};

/** The hosting VTC asks for, and where that choice comes from. */
export interface HostingRequest {
  readonly hosting: EvidenceHosting;
  /**
   * `user`: `automation.evidence_hosting` as the user set it. `preferred`: none set, so
   * `EVIDENCE_HOSTING_PREFERRED` (`attach`, D-cc, reading 225). `unreadable`: the file does not
   * parse, so `EVIDENCE_HOSTING_DEFAULT` (`branch`, always possible): the user may have chosen
   * it in the file that broke.
   */
  readonly source: "user" | "preferred" | "unreadable";
}

/** The hosting VTC asks for (D-cc): the user's, else `attach`; `branch` when the file is unreadable. */
export const hostingRequestOf = (read: UserConfigRead): HostingRequest => {
  if (!read.ok) return { hosting: EVIDENCE_HOSTING_DEFAULT, source: "unreadable" };
  const set = read.config.automation?.evidence_hosting;
  return set === undefined
    ? { hosting: EVIDENCE_HOSTING_PREFERRED, source: "preferred" }
    : { hosting: set, source: "user" };
};

/**
 * The hosting VTC asks for ({@link hostingRequestOf}); {@link evidenceHostingFor} falls back to
 * `branch` where gh is older than 2.99.0 or the remote is not github.com.
 */
export const requestedHostingOf = (read: UserConfigRead): EvidenceHosting =>
  hostingRequestOf(read).hosting;

// --------------------------------------------------------------------- probe

/** What this machine offers automation (no login detail, no token). */
export interface AutomationProbe {
  /** `gh --version`'s first line, or `null` when gh is not on PATH. */
  readonly ghVersion: string | null;
  /** `gh auth status` exited 0; `null` when it was not asked (the daemon asks later, `ghLogin`). */
  readonly ghLoggedIn: boolean | null;
  /** The repo's `origin` push URL is on github.com (`isGithubUrl`; GHES is not). */
  readonly githubRemote: boolean;
  /** `ffmpeg -version`'s first line, or `null` when ffmpeg is not on PATH. */
  readonly ffmpeg: string | null;
}

const firstLine = (text: string): string => text.trim().split(/\r?\n/)[0] ?? "";

/**
 * Each probe's limit. The daemon probes before it starts, inside `ensureDaemon`'s 20 s budget, and
 * the three run side by side, so one slow tool cannot use most of it.
 */
export const PROBE_TIMEOUT_MS = 5_000;

const versionLine = async (
  exec: Exec,
  command: string,
  flag: string,
  cwd: string,
): Promise<string | null> => {
  const result = await exec(command, [flag], { cwd, timeoutMs: PROBE_TIMEOUT_MS });
  return result.code === 0 ? firstLine(result.stdout) || command : null;
};

/**
 * Probes gh, ffmpeg and the repo's origin remote. With `login`, also `gh auth status`, of which
 * only the exit code is read (AD-27 rule 1; never `--show-token`, prompts disabled).
 *
 * Every command, `git` included, runs by name in `cwd`, a directory of the user's own (the VTC
 * home), never the repo: on Windows a bare name is also looked up in the working directory first,
 * and a repo could ship an `ffmpeg.exe` or a `git.exe`. `git` reaches the repo with `-C`.
 */
export const probeAutomation = async (
  exec: Exec,
  options: {
    readonly repoRoot: string | null;
    readonly login: boolean;
    readonly cwd: string;
    readonly gh?: string;
  },
): Promise<AutomationProbe> => {
  const gh = options.gh ?? "gh";
  const remote = async (): Promise<boolean> => {
    if (options.repoRoot === null) return false;
    const result = await exec(
      "git",
      ["-C", options.repoRoot, "remote", "get-url", "--push", "origin"],
      {
        cwd: options.cwd,
        timeoutMs: PROBE_TIMEOUT_MS,
      },
    );
    return result.code === 0 && isGithubUrl(result.stdout);
  };
  const [ghVersion, ffmpeg, githubRemote] = await Promise.all([
    versionLine(exec, gh, "--version", options.cwd),
    versionLine(exec, "ffmpeg", "-version", options.cwd),
    remote(),
  ]);
  let ghLoggedIn: boolean | null = null;
  if (options.login) ghLoggedIn = ghVersion !== null && (await ghAuthStatus(exec, gh, options.cwd));
  return { ghVersion, ghLoggedIn, githubRemote, ffmpeg };
};

/**
 * Whether `gh auth status` exits 0 (AD-27 rule 1): only the exit code is read, prompts are
 * disabled, and the command runs by name in the user's own directory.
 */
const ghAuthStatus = async (exec: Exec, gh: string, cwd: string): Promise<boolean> =>
  (
    await exec(gh, ["auth", "status"], {
      cwd,
      env: { GH_PROMPT_DISABLED: "1" },
      timeoutMs: 20_000,
    })
  ).code === 0;

/**
 * `AutomationDeps.ghLogin` (D-bz, contracts 5.2.0): the daemon asks it when it starts and then
 * periodically, so a logged-out gh turns automation off with a visible note. Without gh on PATH
 * (`ghVersion` null at the daemon's probe) it answers `false` and runs nothing.
 */
export const ghLoginProbe = (
  exec: Exec,
  options: { readonly ghVersion: string | null; readonly cwd: string; readonly gh?: string },
): (() => Promise<boolean>) => {
  const gh = options.gh ?? "gh";
  return () =>
    options.ghVersion === null
      ? Promise.resolve(false)
      : ghAuthStatus(exec, gh, options.cwd).catch(() => false);
};

/**
 * `AutomationDeps.vtcAdvisories` (D-bv (4), contracts 5.3.0, spine §5 reading 216): the gates'
 * offline osv-scanner pass over the lockfile this `vtc` was built from (`CliRuntime.vtcLockfile`),
 * with the pinned scanner and the database `vtc calibrate` downloaded, in the gate sandbox (or
 * unconfined only under the user's `gates.allow_unsandboxed`). `null` without a lockfile or the
 * database (nothing is downloaded for it); a scan that failed throws, and the daemon tells it.
 */
export const vtcAdvisoriesScan = (options: {
  readonly vtcHome: string;
  readonly lockfile: () => Uint8Array | undefined;
  readonly allowUnsandboxed: boolean;
  /** Default: the gate runner's pinned scanner store. */
  readonly scanners?: gates.ScannerStore;
  /** Default: `gates.scanLockfileAdvisories`. */
  readonly scan?: (request: gates.OsvScanRequest) => Promise<gates.OsvScanResult>;
}): NonNullable<AutomationDeps["vtcAdvisories"]> => {
  return async () => {
    const lockfile = options.lockfile();
    if (lockfile === undefined) return null;
    const result = await (options.scan ?? gates.scanLockfileAdvisories)({
      vtcHome: options.vtcHome,
      scanners: options.scanners ?? gates.createScannerStore({ vtcHome: options.vtcHome }),
      lockfile,
      logDir: join(options.vtcHome, "logs", "osv-scan"),
      env: process.env,
      allowUnsandboxed: options.allowUnsandboxed,
    });
    if (result.ok) return result.advisories;
    if (result.reason === "no_database") return null;
    throw new Error(result.detail);
  };
};

/** The hosting PR media get, and why it is not the one the user asked for. */
export interface HostingDecision {
  readonly hosting: EvidenceHosting;
  /** Set when `attach` was asked for and this machine or repo cannot do it. */
  readonly fallback?: string;
}

/**
 * Readings 196 and 225: `attach` (`gh … --attach`, asked for when the user set nothing) only when
 * gh is at least `GH_ATTACH_MIN_VERSION` and the origin remote is on github.com; otherwise the
 * orphan `vtc-evidence` branch, which is always possible.
 */
export const evidenceHostingFor = (
  requested: EvidenceHosting,
  probe: Pick<AutomationProbe, "ghVersion" | "githubRemote">,
): HostingDecision => {
  if (requested === "branch") return { hosting: "branch" };
  if (probe.ghVersion === null) return { hosting: "branch", fallback: "gh is not on PATH" };
  if (!versionAtLeast(probe.ghVersion, GH_ATTACH_MIN_VERSION)) {
    const found = /\d+\.\d+\.\d+/.exec(probe.ghVersion)?.[0] ?? "unknown";
    return {
      hosting: "branch",
      fallback: `gh version ${found} is older than ${GH_ATTACH_MIN_VERSION}, the first with --attach`,
    };
  }
  if (!probe.githubRemote)
    return {
      hosting: "branch",
      fallback: "the origin remote is not on github.com (gh --attach is github.com only)",
    };
  return { hosting: "attach" };
};

// ------------------------------------------------------------- engine seams

/** What the evidence recorder is built with: the gate runner's own deps (AD-24, reading 207). */
export type EvidenceRecorderDeps = Pick<GateRunnerDeps, "repoRoot" | "vtcHome"> &
  Partial<Pick<GateRunnerDeps, "git" | "allowUnsandboxed">>;

/**
 * `@vtc/compiler`'s `createArmPluginCompiler` (roles-compiler, D-cg): the `ArmPluginCompiler` over
 * one compiled base plugin on disk.
 */
export type CreateArmPluginCompiler = (options: {
  readonly pluginDir: string;
}) => ArmPluginCompiler;

/** The implementations behind `AutomationDeps` and `armPlugins`; each absent one is left out. */
export interface AutomationFactories {
  /** Engine core's `git.createGitPlumbing`. */
  readonly plumbing?: CreateGitPlumbing;
  /** The gate runner's evidence recorder (`gates.createEvidenceRecorder`). */
  readonly evidence?: (deps: EvidenceRecorderDeps) => EvidenceRecorder;
}

/**
 * Compile-time: `true` while `namespace` exports nothing under `key`, and once it does, whether
 * that export is assignable to the frozen seam type `T`. {@link ShippedSeamsFit} holds each seam
 * to it, so a changed signature fails the build at the merge instead of leaving the seam out.
 */
export type ShippedFits<NS, K extends string, T> = K extends keyof NS
  ? NS[K] extends T
    ? true
    : false
  : true;

type Assert<T extends true> = T;

/** Each seam the cli looks up by name fits its frozen type (see {@link ShippedFits}). */
export type ShippedSeamsFit = [
  Assert<ShippedFits<typeof git, "createGitPlumbing", CreateGitPlumbing>>,
  Assert<
    ShippedFits<
      typeof gates,
      "createEvidenceRecorder",
      NonNullable<AutomationFactories["evidence"]>
    >
  >,
  Assert<ShippedFits<typeof compiler, "createArmPluginCompiler", CreateArmPluginCompiler>>,
];

/**
 * The function `namespace` exports under `key`, or `undefined` while it exports none. Each caller
 * casts it to the seam type that {@link ShippedSeamsFit} checks the export against.
 */
const shipped = (namespace: object, key: string): unknown => {
  const value = (namespace as Readonly<Record<string, unknown>>)[key];
  return typeof value === "function" ? value : undefined;
};

/** The shipped implementations of the engine seams (see the header). */
export const shippedAutomationFactories = (): AutomationFactories => {
  const plumbing = shipped(git, "createGitPlumbing") as CreateGitPlumbing | undefined;
  const evidence = shipped(gates, "createEvidenceRecorder") as AutomationFactories["evidence"];
  return {
    ...(plumbing === undefined ? {} : { plumbing }),
    ...(evidence === undefined ? {} : { evidence }),
  };
};

/** The compiler's `createArmPluginCompiler`, once it has landed; `undefined` before. */
export const shippedArmPluginCompilerFactory = (): CreateArmPluginCompiler | undefined =>
  shipped(compiler, "createArmPluginCompiler") as CreateArmPluginCompiler | undefined;

/** What a built recorder without `captureBeforeAfter` (before contracts 5.4.0) answers. */
const NO_BEFORE_AFTER: BeforeAfterResult = {
  files: [],
  failed: [],
  partial: {
    reason: "capture_failed",
    detail: "this vtc build's evidence recorder has no UI before/after capture",
  },
};

/**
 * An evidence recorder built on first use, like the Gate Runner: the daemon starts without the
 * visual toolchain, and a recorder that cannot be built fails the capture that needed it, which
 * the upstream module retries once and then reports as "evidence capture failed" (D-ce). Every
 * method is forwarded, the UI before/after capture of D-ct (reading 223) too: whether the built
 * recorder has one is known only once it is built, so without one the call answers `partial`
 * and the PR is labelled `evidence: partial` with the reason, never left without a word.
 */
const lazyRecorder = (create: () => EvidenceRecorder): EvidenceRecorder => {
  let recorder: EvidenceRecorder | undefined;
  const get = (): EvidenceRecorder => (recorder ??= create());
  return {
    captureBeforeAfter: async (request) => {
      const built = get();
      return built.captureBeforeAfter === undefined
        ? NO_BEFORE_AFTER
        : built.captureBeforeAfter(request);
    },
    capture: async (request) => get().capture(request),
    renderGateReport: async (request) => get().renderGateReport(request),
  };
};

/**
 * `AutomationDeps.upstream` over the user's config as it is at each read (AD-27 rule 5): every
 * property access reads `~/.vtc/config.yaml` again when it changed, so an opt-out (or a file that
 * no longer parses, which turns sharing off) takes effect while the daemon runs.
 */
const liveUpstream = (user: () => UserConfigRead): AutomationDeps["upstream"] => {
  const now = (): AutomationDeps["upstream"] => upstreamSettingsOf(user());
  return Object.defineProperties({} as AutomationDeps["upstream"], {
    repo: { enumerable: true, get: () => now().repo },
    share: { enumerable: true, get: () => now().share },
    checkout: { enumerable: true, get: () => now().checkout },
  });
};

/**
 * `EngineDeps.automation` (AD-27 rule 7): the user's upstream settings and the hosting they ask
 * for, both read live ({@link liveUpstream}), what this machine allows (probed once, when the
 * daemon starts), whether ffmpeg is there, and the engine seams that exist. The `gh`-backed issue
 * and PR services are left to the upstream module's defaults.
 */
export const buildAutomationDeps = (input: {
  /** The user's config as it is now: `liveUserConfig` in the daemon. */
  readonly user: () => UserConfigRead;
  readonly probe: AutomationProbe;
  readonly factories: AutomationFactories;
  readonly gateDeps: EvidenceRecorderDeps;
  /** `AutomationDeps.ghLogin` ({@link ghLoginProbe}); absent: none is passed. */
  readonly ghLogin?: () => Promise<boolean>;
  /** `AutomationDeps.vtcAdvisories` ({@link vtcAdvisoriesScan}); absent: none is passed. */
  readonly vtcAdvisories?: AutomationDeps["vtcAdvisories"];
}): AutomationDeps => {
  const { factories, probe, user } = input;
  const create = factories.evidence;
  return {
    upstream: liveUpstream(user),
    get hosting() {
      return evidenceHostingFor(requestedHostingOf(user()), probe).hosting;
    },
    ffmpeg: probe.ffmpeg !== null,
    ...(create === undefined ? {} : { evidence: lazyRecorder(() => create(input.gateDeps)) }),
    ...(factories.plumbing === undefined ? {} : { plumbing: factories.plumbing }),
    ...(input.ghLogin === undefined ? {} : { ghLogin: input.ghLogin }),
    ...(input.vtcAdvisories === undefined ? {} : { vtcAdvisories: input.vtcAdvisories }),
  };
};

/**
 * `EngineDeps.armPlugins` (D-cg, reading 201): the compiler's arm plugin compiler over this vtc's
 * compiled plugin of the arm's host (in development the product repo's, in the binary the
 * extracted one). The directory is resolved, and the compiler built, when an arm is compiled, so
 * the daemon extracts nothing at start. The compiler refuses a host whose runs do not load the
 * compiled agent (only Claude Code needs arm plugins).
 */
export const armPluginCompiler = (
  create: CreateArmPluginCompiler,
  pluginDir: (host: HostId) => string,
): ArmPluginCompiler => ({
  compileArm: (request) => create({ pluginDir: pluginDir(request.host) }).compileArm(request),
});
