/**
 * Composition (AD-1 rule 4, AD-19; owner: cli+binary team). The only place that builds the
 * daemon's dependencies: the storage driver for this runtime, the Gate Runner (with the user's
 * `gates.allow_unsandboxed`, D-al), the host adapters, the asset bundle, the auto-resume timer,
 * the `gh`-backed PR service and, since contracts 4.5.0, the `gh`-backed Level-3 service (AD-23)
 * and the research HTTP client with its network guard (AD-22), the research fetchers' keys and
 * the optional keyed search provider (H-3: none by default, so search runs on the host's own web
 * search). Since contracts 5.0.0 also automatic issues and PRs (`EngineDeps.automation`, AD-27
 * rule 7) and the Lookback replay arms' plugin compiler (`EngineDeps.armPlugins`, reading 201),
 * both built in `automation-wiring.ts`.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ADAPTER_FACTORIES, type AdapterFactoryOptions } from "@vtc/adapters";
import { ENGINE_NAME, gates, git, mcp, runDaemon } from "@vtc/engine";
import {
  CONTRACTS_VERSION,
  type ArmPluginCompiler,
  type AssetBundle,
  type AutomationDeps,
  type AutoResumeScheduler,
  type CreateGateRunner,
  type DaemonOptions,
  type EngineClient,
  type EngineDeps,
  type FetcherId,
  type GateRunner,
  type HostAdapter,
  type ModelPrice,
  type HostId,
  type HttpClient,
  type PullRequestService,
  type RemoteMergeService,
  type RunningDaemon,
  type SearchProvider,
  type StorageFactory,
} from "@vtc/shared";
import {
  armPluginCompiler,
  buildAutomationDeps,
  ghLoginProbe,
  vtcAdvisoriesScan,
  probeAutomation,
  shippedArmPluginCompilerFactory,
  shippedAutomationFactories,
  type AutomationFactories,
  type CreateArmPluginCompiler,
} from "./automation-wiring.js";
import type { CliIo, CommandContext } from "./commands/types.js";
import { ensureDaemon } from "./daemon.js";
import { contractsAtLeast } from "./bridge.js";
import { interactiveTerminal, ttyConfirm } from "./confirm.js";
import { createGhRemoteMerge, createGhRunner } from "./gh-remote-merge.js";
import { bunResolver, createHttpClient, nodeResolver, type Resolve } from "./http-client.js";
import { guardHumanOnly } from "./human-channel.js";
import { readInstallToken } from "./token.js";
import { requireRepoRoot, requireVtcProject } from "./repo.js";
import { exec as runExec, type Exec } from "./process.js";
import { runtime } from "./runtime.js";
import { createWakeScheduler } from "./scheduler.js";
import { loadStorage } from "./storage.js";
import {
  allowUnsandboxedOf,
  liveUserConfig,
  passthroughOf,
  pricesOf,
  readUserConfig,
  researchApiKeyOf,
  researchSearchProviderOf,
} from "./user-config.js";
import { VERSION } from "./version.js";

export { VERSION } from "./version.js";

/** The parts the cli constructs; `composeEngineDeps` turns them into `EngineDeps`. */
export interface EngineParts {
  readonly repoRoot: string;
  readonly vtcHome: string;
  /** `ensureInstallToken(vtcHome)` (`token.ts`); the daemon never touches the token file. */
  readonly installToken: string;
  readonly openStorage: StorageFactory;
  readonly gateRunner: GateRunner;
  readonly adapters: Readonly<Partial<Record<HostId, HostAdapter>>>;
  /** The dashboard export and the compiled plugins, incl. the role contracts (AD-20). */
  readonly assets: AssetBundle;
  readonly scheduler: AutoResumeScheduler;
  /** The feature PR service (§6.7 Level 2): `gh`-backed in production, a fake in tests. */
  readonly pullRequests: PullRequestService;
  /** Level-3 auto-merge and the post-merge watch (AD-23): `gh`-backed, a fake in tests. */
  readonly remoteMerge?: RemoteMergeService;
  /** The research fetchers' HTTP client (AD-22); absent where no resolver is available. */
  readonly http?: HttpClient;
  /** A research fetcher's own key (`~/.vtc/config.yaml` `research.api_keys`, reading 120). */
  readonly researchApiKey?: (fetcher: FetcherId) => string | undefined;
  /**
   * The keyed provider behind the `search` fetcher (`research.search_provider`, H-3, reading
   * 156); absent by default, when research search runs on the host's own web search.
   */
  readonly researchSearchProvider?: SearchProvider;
  /** The price table (`~/.vtc/config.yaml` `prices`, §11, reading 152). */
  readonly prices?: Readonly<Record<string, ModelPrice>>;
  /** Automatic issues and PRs (AD-27 rule 7); absent: automation is off with a visible note. */
  readonly automation?: AutomationDeps;
  /** Lookback replay arms' plugins (reading 201); absent: Claude-led replays wait for a RETRO. */
  readonly armPlugins?: ArmPluginCompiler;
}

/**
 * The research HTTP client over the runtime's `fetch` (AD-22 rule 1), or `undefined` when there
 * is no resolver to run the private-address guard with: the fetchers are then unavailable and
 * new facts stay UNVERIFIED, which fails closed. The binary resolves with Bun's DNS, Node in
 * development with `node:dns` (a runtime-safe built-in since spine §5 reading 133).
 */
export const defaultHttpClient = (
  resolve: Resolve | null = bunResolver() ?? nodeResolver(),
  fetch: typeof globalThis.fetch = globalThis.fetch,
): HttpClient | undefined => (resolve === null ? undefined : createHttpClient({ fetch, resolve }));

export const engineVersions = (): EngineDeps["versions"] => ({
  engine: `${ENGINE_NAME}@${VERSION}`,
  contracts: CONTRACTS_VERSION,
});

export const composeEngineDeps = (parts: EngineParts): EngineDeps => ({
  ...parts,
  versions: engineVersions(),
});

/**
 * A Gate Runner built on first use. The daemon serves status, the dashboard and every
 * non-gate step without it; a Gate Runner that cannot be built fails the gate run that needed
 * it, which the engine records as a gate infrastructure failure (§6.8), never as a pass.
 */
export const lazyGateRunner = (create: () => GateRunner): GateRunner => {
  let runner: GateRunner | undefined;
  const get = (): GateRunner => (runner ??= create());
  return {
    run: async (request) => get().run(request),
    checkWriteScope: async (request) => get().checkWriteScope(request),
    // The optional novelty seam (AD-24 rule 8, reading 127) is forwarded too: core reads it as
    // `gateRunner.checkNovelty?.(...)`, so a wrapper without it would leave every G2 direction
    // `unchecked` in the shipped binary. A built runner without the method fails the call, which
    // core treats as an unchecked direction.
    checkNovelty: async (request) => {
      const g = get();
      if (g.checkNovelty === undefined) throw new Error("the Gate Runner has no checkNovelty");
      return g.checkNovelty(request);
    },
    recordDesignChoice: async (entry, scope) => {
      const g = get();
      if (g.recordDesignChoice === undefined) {
        throw new Error("the Gate Runner has no recordDesignChoice");
      }
      return g.recordDesignChoice(entry, scope);
    },
  };
};

/** How the cli constructs an adapter (`ADAPTER_FACTORIES`, `@vtc/adapters`). */
export type AdapterFactory = (options?: AdapterFactoryOptions) => HostAdapter;

/** What every adapter is constructed with (spine §5 reading 66). */
export interface AdapterContext {
  readonly vtcHome: string;
  /** The host's compiled plugin on disk (`CliRuntime.pluginDir`). */
  readonly pluginDir: (host: HostId, vtcHome: string) => string;
  /** `~/.vtc/config.yaml` `env_passthrough` (D-ak): names that reach headless host runs. */
  readonly envPassthrough?: readonly string[];
}

/**
 * One adapter per host registered in `ADAPTER_FACTORIES` (AD-6 rule 6), each constructed with
 * `{ pluginDir, vtcHome, vtcVersion }`. Models are never passed: the engine resolves every model
 * (`SpawnRoleRequest.model`). Without `pluginDir` a headless Claude run is refused, so it is
 * always passed.
 */
export const createAdapters = (
  factories: Readonly<Partial<Record<HostId, AdapterFactory>>>,
  context: AdapterContext,
): Partial<Record<HostId, HostAdapter>> => {
  const adapters: Partial<Record<HostId, HostAdapter>> = {};
  for (const [host, factory] of Object.entries(factories) as [HostId, AdapterFactory][])
    adapters[host] = factory({
      pluginDir: context.pluginDir(host, context.vtcHome),
      vtcHome: context.vtcHome,
      vtcVersion: VERSION,
      ...(context.envPassthrough === undefined || context.envPassthrough.length === 0
        ? {}
        : { envPassthrough: context.envPassthrough }),
    });
  return adapters;
};

export interface BuildEnginePartsOptions {
  readonly repoRoot: string;
  readonly vtcHome: string;
  readonly installToken: string;
  readonly assets: AssetBundle;
  /**
   * Defaults: the runtime's storage driver, `gates.createGateRunner`, `ADAPTER_FACTORIES` with
   * the runtime's plugin dirs, the persisted wake scheduler and the `gh`-backed PR service
   * (`ghCommand`, default `gh`).
   */
  readonly openStorage?: StorageFactory;
  readonly createGateRunner?: CreateGateRunner;
  readonly adapterFactories?: Readonly<Partial<Record<HostId, AdapterFactory>>>;
  readonly pluginDir?: (host: HostId, vtcHome: string) => string;
  readonly scheduler?: AutoResumeScheduler;
  readonly pullRequests?: PullRequestService;
  /** Default: the `gh`-backed service on `ghCommand` (AD-23). */
  readonly remoteMerge?: RemoteMergeService;
  /** Default: {@link defaultHttpClient}. `null` injects none. */
  readonly http?: HttpClient | null;
  readonly ghCommand?: string;
  /**
   * Gate runs without an OS sandbox (D-al, spine §5 reading 69). Default: the user-level
   * `gates.allow_unsandboxed` of `~/.vtc/config.yaml` (`gatesAllowUnsandboxed`); never from
   * `project.yaml`, and false when the file does not parse.
   */
  readonly allowUnsandboxed?: boolean;
  /**
   * `EngineDeps.automation` (AD-27 rule 7). Default: {@link buildAutomationDeps} over the user
   * config, read live (`liveUserConfig`: an opt-out flipped while the daemon runs is seen), and a
   * probe of this machine when the daemon starts (`gh --version`, `ffmpeg -version`, the origin
   * remote), and `ghLogin`, which the daemon asks for the login (D-bz). `null` injects none.
   */
  readonly automation?: AutomationDeps | null;
  /** The seams behind the default automation. Default: {@link shippedAutomationFactories}. */
  readonly automationFactories?: AutomationFactories;
  /** Runs the default automation probe. Default: the cli's `exec`; tests inject a fake (D-cc). */
  readonly exec?: Exec;
  /**
   * The compiler's `createArmPluginCompiler`, bound to the runtime's plugin dir as
   * `EngineDeps.armPlugins` (reading 201). Default: {@link shippedArmPluginCompilerFactory}.
   * `null` injects none.
   */
  readonly createArmPluginCompiler?: CreateArmPluginCompiler | null;
}

/** The default `EngineDeps.automation`: the user's settings and what this machine allows. */
const defaultAutomation = async (
  options: BuildEnginePartsOptions,
  allowUnsandboxed: boolean,
): Promise<AutomationDeps> => {
  const exec = options.exec ?? runExec;
  const probe = await probeAutomation(exec, {
    repoRoot: options.repoRoot,
    login: false,
    // gh, ffmpeg and git run by name outside the repo (a repo could ship an ffmpeg.exe)
    cwd: options.vtcHome,
    ...(options.ghCommand === undefined ? {} : { gh: options.ghCommand }),
  });
  return buildAutomationDeps({
    user: liveUserConfig(options.vtcHome),
    probe,
    factories: options.automationFactories ?? shippedAutomationFactories(),
    gateDeps: {
      repoRoot: options.repoRoot,
      vtcHome: options.vtcHome,
      git: git.createGitOps({ repoRoot: options.repoRoot }),
      allowUnsandboxed,
    },
    // D-bz: the daemon asks gh for the login when it starts and periodically, not here
    ghLogin: ghLoginProbe(exec, {
      ghVersion: probe.ghVersion,
      cwd: options.vtcHome,
      ...(options.ghCommand === undefined ? {} : { gh: options.ghCommand }),
    }),
    // D-bv (4): the daemon scans this vtc's own lockfile offline once a day (reading 216)
    vtcAdvisories: vtcAdvisoriesScan({
      vtcHome: options.vtcHome,
      lockfile: () => runtime().vtcLockfile(),
      allowUnsandboxed,
    }),
  });
};

/** Builds every part `vtc engine --daemon` injects. Constructing them starts no process. */
export const buildEngineParts = async (options: BuildEnginePartsOptions): Promise<EngineParts> => {
  const { repoRoot, vtcHome } = options;
  const createGateRunner = options.createGateRunner ?? gates.createGateRunner;
  const userConfig = readUserConfig(vtcHome);
  const allowUnsandboxed = options.allowUnsandboxed ?? allowUnsandboxedOf(userConfig);
  const http = options.http === null ? undefined : (options.http ?? defaultHttpClient());
  const researchApiKey = researchApiKeyOf(userConfig);
  const researchSearchProvider = researchSearchProviderOf(userConfig);
  const prices = pricesOf(userConfig);
  const pluginDir = options.pluginDir ?? ((host, home) => runtime().pluginDir(host, home));
  const automation =
    options.automation === null
      ? undefined
      : (options.automation ?? (await defaultAutomation(options, allowUnsandboxed)));
  const createArm =
    options.createArmPluginCompiler === null
      ? undefined
      : (options.createArmPluginCompiler ?? shippedArmPluginCompilerFactory());
  return {
    repoRoot,
    vtcHome,
    installToken: options.installToken,
    openStorage: options.openStorage ?? (await loadStorage()),
    // the Gate Runner reads and diffs through the engine's GitOps only (AD-13 rule 4); it
    // detects the machine's gate sandbox itself (no `sandbox` passed, D-al)
    gateRunner: lazyGateRunner(() =>
      createGateRunner({
        repoRoot,
        vtcHome,
        git: git.createGitOps({ repoRoot }),
        allowUnsandboxed,
      }),
    ),
    adapters: createAdapters(options.adapterFactories ?? ADAPTER_FACTORIES, {
      vtcHome,
      pluginDir,
      envPassthrough: passthroughOf(userConfig),
    }),
    assets: options.assets,
    scheduler: options.scheduler ?? createWakeScheduler(vtcHome),
    pullRequests: options.pullRequests ?? git.createGhPullRequests(repoRoot, options.ghCommand),
    remoteMerge:
      options.remoteMerge ??
      createGhRemoteMerge({ repoRoot, gh: createGhRunner(repoRoot, options.ghCommand) }),
    ...(http === undefined ? {} : { http }),
    ...(researchApiKey === undefined ? {} : { researchApiKey }),
    ...(researchSearchProvider === undefined ? {} : { researchSearchProvider }),
    ...(Object.keys(prices).length === 0 ? {} : { prices }),
    ...(automation === undefined ? {} : { automation }),
    ...(createArm === undefined
      ? {}
      : { armPlugins: armPluginCompiler(createArm, (host) => pluginDir(host, vtcHome)) }),
  };
};

/** Stops every adapter's child processes and subscriptions (AD-6 lifecycle). */
export const disposeAdapters = async (parts: Pick<EngineParts, "adapters">): Promise<void> => {
  await Promise.allSettled(Object.values(parts.adapters).map((a) => a.dispose()));
};

/** `vtc engine --daemon`: the engine-core team's `runDaemon` with the cli's wiring. */
export const startDaemon = (parts: EngineParts, options: DaemonOptions): Promise<RunningDaemon> =>
  runDaemon(composeEngineDeps(parts), options);

/**
 * `$VTC_HOME` made absolute, or `~/.vtc`. A relative value resolves against the caller's cwd
 * once, here: the detached daemon runs in the repo root and must see the same home.
 */
export const resolveVtcHome = (
  env: Readonly<Record<string, string | undefined>>,
  cwd: string = process.cwd(),
): string =>
  env.VTC_HOME === undefined || env.VTC_HOME === ""
    ? join(homedir(), ".vtc")
    : resolve(cwd, env.VTC_HOME);

/**
 * The control commands' client: an MCP client of the repo's daemon socket (AD-19 rule 4),
 * starting the daemon when none is running. Refuses a repo `vtc init` never set up.
 */
export const connectToRepoEngine = async (cwd: string, vtcHome: string): Promise<EngineClient> => {
  const repoRoot = await requireRepoRoot(cwd);
  requireVtcProject(repoRoot);
  const discovery = await ensureDaemon({
    vtcHome,
    repoRoot,
    selfCommand: runtime().selfCommand,
  });
  return mcp.connectEngineClient(discovery.mcp_socket);
};

/** The contracts version whose engine takes `resume` with `adopt` (spine §5 reading 88). */
const ADOPT_SINCE = "4.4.0";

/**
 * A connection to the repo's daemon that proves a human (spine §5 readings 71 and 88): only in
 * an interactive terminal, only after the human says yes to `what`, and only then is the install
 * token read and sent in the hello.
 */
export const connectHumanToRepoEngine = async (
  cwd: string,
  vtcHome: string,
  what: string,
): Promise<EngineClient> => {
  if (!interactiveTerminal())
    throw new Error(`to ${what} you confirm it yourself: run it in an interactive terminal`);
  const repoRoot = await requireRepoRoot(cwd);
  requireVtcProject(repoRoot);
  const discovery = await ensureDaemon({ vtcHome, repoRoot, selfCommand: runtime().selfCommand });
  if (!contractsAtLeast(discovery.contracts_version, ADOPT_SINCE))
    throw new Error(
      `the running engine speaks contracts ${discovery.contracts_version}: run vtc engine --stop in the repo, then try again`,
    );
  if (!(await ttyConfirm(`You are about to ${what}. Is this your decision?`)))
    throw new Error("not confirmed: nothing was sent");
  return mcp.connectEngineClient(discovery.mcp_socket, CONTRACTS_VERSION, {
    installToken: readInstallToken(vtcHome),
  });
};

/**
 * The context every command runs with. The engine client connects lazily, once, and never calls
 * a human-only tool (`guardHumanOnly`, D-an): its hello carries no install token.
 */
export const createCommandContext = (
  io: CliIo,
  cwd: string,
  vtcHome: string,
  connect: () => Promise<EngineClient> = () => connectToRepoEngine(cwd, vtcHome),
): CommandContext => {
  let client: Promise<EngineClient> | undefined;
  return {
    io,
    cwd,
    vtcHome,
    engine: () => (client ??= connect().then(guardHumanOnly)),
    humanEngine: (what) => connectHumanToRepoEngine(cwd, vtcHome, what),
  };
};
