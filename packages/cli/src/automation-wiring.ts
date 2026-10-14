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
 * Merge note (readings 207 and 209): `git.createGitPlumbing` (engine core), the gate runner's
 * evidence recorder and the compiler's `compileArm` are built in other branches this round, so
 * {@link shippedAutomationFactories} looks them up by name and leaves each one out until it is
 * there. Without a recorder no automatic PR opens (issues still do); without `compileArm` a replay
 * on a Claude-led run waits for the next RETRO.
 */
import * as compiler from "@vtc/compiler";
import { gates, git } from "@vtc/engine";
import {
  DEFAULT_UPSTREAM_REPO,
  EVIDENCE_HOSTING_DEFAULT,
  GH_ATTACH_MIN_VERSION,
  type ArmPlugin,
  type ArmPluginCompiler,
  type ArmPluginRequest,
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

const versionLine = async (exec: Exec, command: string, flag: string): Promise<string | null> => {
  const result = await exec(command, [flag], { timeoutMs: 15_000 });
  return result.code === 0 ? firstLine(result.stdout) || command : null;
};

/**
 * Probes gh, ffmpeg and the repo's origin remote. With `login`, also `gh auth status`, of which
 * only the exit code is read (AD-27 rule 1; never `--show-token`, prompts disabled).
 */
export const probeAutomation = async (
  exec: Exec,
  options: { readonly repoRoot: string | null; readonly login: boolean; readonly gh?: string },
): Promise<AutomationProbe> => {
  const gh = options.gh ?? "gh";
  const remote = async (): Promise<boolean> => {
    if (options.repoRoot === null) return false;
    const result = await exec("git", ["remote", "get-url", "--push", "origin"], {
      cwd: options.repoRoot,
      timeoutMs: 15_000,
    });
    return result.code === 0 && isGithubUrl(result.stdout);
  };
  const [ghVersion, ffmpeg, githubRemote] = await Promise.all([
    versionLine(exec, gh, "--version"),
    versionLine(exec, "ffmpeg", "-version"),
    remote(),
  ]);
  let ghLoggedIn: boolean | null = null;
  if (options.login)
    ghLoggedIn =
      ghVersion !== null &&
      (
        await exec(gh, ["auth", "status"], {
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

/** `@vtc/compiler`'s `compileArm` as the cli binds it: an arm request and the base plugin dir. */
export type CompileArm = (request: ArmPluginRequest, basePluginDir: string) => Promise<ArmPlugin>;

/** The implementations behind `AutomationDeps` and `armPlugins`; each absent one is left out. */
export interface AutomationFactories {
  /** Engine core's `git.createGitPlumbing`. */
  readonly plumbing?: CreateGitPlumbing;
  /** The gate runner's evidence recorder (`gates.createEvidenceRecorder`). */
  readonly evidence?: (deps: EvidenceRecorderDeps) => EvidenceRecorder;
}

/** A function the namespace exports under `name`, or `undefined` while it does not. */
const exported = (namespace: object, name: string): unknown => {
  const value = (namespace as Readonly<Record<string, unknown>>)[name];
  return typeof value === "function" ? value : undefined;
};

/** The shipped implementations, each once its team's branch has landed (see the merge note). */
export const shippedAutomationFactories = (): AutomationFactories => {
  const plumbing = exported(git, "createGitPlumbing") as CreateGitPlumbing | undefined;
  const evidence = exported(gates, "createEvidenceRecorder") as AutomationFactories["evidence"];
  return {
    ...(plumbing === undefined ? {} : { plumbing }),
    ...(evidence === undefined ? {} : { evidence }),
  };
};

/** The compiler's `compileArm`, once it has landed; `undefined` before. */
export const shippedCompileArm = (): CompileArm | undefined =>
  exported(compiler, "compileArm") as CompileArm | undefined;

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
 * `EngineDeps.automation` (AD-27 rule 7): the user's upstream settings, the hosting this machine
 * allows, whether ffmpeg is there, and the engine seams that exist. The `gh`-backed issue and PR
 * services are left to the upstream module's defaults.
 */
export const buildAutomationDeps = (input: {
  readonly user: UserConfigRead;
  readonly probe: AutomationProbe;
  readonly factories: AutomationFactories;
  readonly gateDeps: EvidenceRecorderDeps;
}): AutomationDeps => {
  const { factories } = input;
  const create = factories.evidence;
  return {
    upstream: upstreamSettingsOf(input.user),
    hosting: evidenceHostingFor(requestedHostingOf(input.user), input.probe).hosting,
    ffmpeg: input.probe.ffmpeg !== null,
    ...(create === undefined ? {} : { evidence: lazyRecorder(() => create(input.gateDeps)) }),
    ...(factories.plumbing === undefined ? {} : { plumbing: factories.plumbing }),
  };
};

/**
 * `EngineDeps.armPlugins` (D-cg, reading 201): `compileArm` bound to this vtc's compiled plugin of
 * the arm's host (in development the product repo's, in the binary the extracted one). The
 * directory is resolved when an arm is compiled, so the daemon extracts nothing at start.
 */
export const armPluginCompiler = (
  compile: CompileArm,
  pluginDir: (host: HostId) => string,
): ArmPluginCompiler => ({
  compileArm: (request) => compile(request, pluginDir(request.host)),
});
