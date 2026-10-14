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
 * is kept, and no token is ever read.
 *
 * The user's settings are read live (AD-27 rule 5): `upstream.share` is an opt-out the engine
 * checks when an item is queued and again when it is sent, and the daemon runs for long, so each
 * read of `AutomationDeps.upstream` (and `hosting`) goes back to `~/.vtc/config.yaml`
 * (`liveUserConfig`, re-read only when the file changed).
 *
 * Merge note (readings 207 and 209): `git.createGitPlumbing` (engine core), the gate runner's
 * `gates.createEvidenceRecorder` and the compiler's `createArmPluginCompiler` (roles-compiler) are
 * built in other branches this round. {@link shippedAutomationFactories} and
 * {@link shippedArmPluginCompilerFactory} look each one up by its export name and leave it out
 * while it is missing; {@link ShippedSeamsFit} checks at compile time that each export, once it
 * lands, fits its frozen seam type, so a changed signature fails the build. Without a recorder no automatic PR opens (issues still do;
 * `vtc doctor`'s `evidence` line says so); without the arm compiler a replay on a Claude-led run
 * waits for the next RETRO (`vtc lookback approve` warns). At that merge the integrator flips the
 * matching flag in `test/round4-merge.ts`, which the seam tests hold the lookups to.
 */
import * as compiler from "@vtc/compiler";
import { gates, git } from "@vtc/engine";
import {
  DEFAULT_UPSTREAM_REPO,
  EVIDENCE_HOSTING_DEFAULT,
  GH_ATTACH_MIN_VERSION,
  type ArmPluginCompiler,
  type AutomationDeps,
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

/** `automation.evidence_hosting` as the user set it; `branch` (the default) when unset or unreadable. */
export const requestedHostingOf = (read: UserConfigRead): EvidenceHosting =>
  (read.ok ? read.config.automation?.evidence_hosting : undefined) ?? EVIDENCE_HOSTING_DEFAULT;

// --------------------------------------------------------------------- probe

/** What this machine offers automation (no login detail, no token). */
export interface AutomationProbe {
  /** `gh --version`'s first line, or `null` when gh is not on PATH. */
  readonly ghVersion: string | null;
  /** `gh auth status` exited 0; `null` when it was not asked (the daemon never asks). */
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
 * `gh` and `ffmpeg` run by name in `cwd`, a directory of the user's own (the VTC home), never the
 * repo: on Windows a bare name is also looked up in the working directory first, and a repo could
 * ship an `ffmpeg.exe`. Only `git remote` runs in the repo.
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
    const result = await exec("git", ["remote", "get-url", "--push", "origin"], {
      cwd: options.repoRoot,
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    return result.code === 0 && isGithubUrl(result.stdout);
  };
  const [ghVersion, ffmpeg, githubRemote] = await Promise.all([
    versionLine(exec, gh, "--version", options.cwd),
    versionLine(exec, "ffmpeg", "-version", options.cwd),
    remote(),
  ]);
  let ghLoggedIn: boolean | null = null;
  if (options.login)
    ghLoggedIn =
      ghVersion !== null &&
      (
        await exec(gh, ["auth", "status"], {
          cwd: options.cwd,
          env: { GH_PROMPT_DISABLED: "1" },
          timeoutMs: 20_000,
        })
      ).code === 0;
  return { ghVersion, ghLoggedIn, githubRemote, ffmpeg };
};

/** The hosting PR media get, and why it is not the one the user asked for. */
export interface HostingDecision {
  readonly hosting: EvidenceHosting;
  /** Set when the user asked for `attach` and this machine or repo cannot do it. */
  readonly fallback?: string;
}

/**
 * Reading 196: `attach` (`gh … --attach`) only when gh is at least `GH_ATTACH_MIN_VERSION` and the
 * origin remote is on github.com; otherwise the orphan `vtc-evidence` branch. `branch` is the
 * default and always possible.
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

/** The shipped implementations, each once its team's branch has landed (see the merge note). */
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

/**
 * An evidence recorder built on first use, like the Gate Runner: the daemon starts without the
 * visual toolchain, and a recorder that cannot be built fails the capture that needed it, which
 * the upstream module retries once and then reports as "evidence capture failed" (D-ce).
 */
const lazyRecorder = (create: () => EvidenceRecorder): EvidenceRecorder => {
  let recorder: EvidenceRecorder | undefined;
  const get = (): EvidenceRecorder => (recorder ??= create());
  return {
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
