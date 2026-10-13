/**
 * Composition (AD-1 rule 4, AD-19; owner: cli+binary team). The only place that builds the
 * daemon's dependencies: the storage driver for this runtime, the Gate Runner, the host
 * adapters, the asset bundle, the auto-resume timer and the `gh`-backed PR service.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import { ENGINE_NAME, gates, git, mcp, runDaemon } from "@vtc/engine";
import {
  CONTRACTS_VERSION,
  type AssetBundle,
  type AutoResumeScheduler,
  type CreateGateRunner,
  type DaemonOptions,
  type EngineClient,
  type EngineDeps,
  type GateRunner,
  type HostAdapter,
  type HostId,
  type PullRequestService,
  type RunningDaemon,
  type StorageFactory,
} from "@vtc/shared";
import type { CliIo, CommandContext } from "./commands/types.js";
import { ensureDaemon } from "./daemon.js";
import { requireRepoRoot, requireVtcProject } from "./repo.js";
import { runtime } from "./runtime.js";
import { createWakeScheduler } from "./scheduler.js";
import { loadStorage } from "./storage.js";
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
}

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
  };
};

/** One adapter per host registered in `ADAPTER_FACTORIES` (AD-6 rule 6). */
export const createAdapters = (
  factories: Readonly<Partial<Record<HostId, () => HostAdapter>>> = ADAPTER_FACTORIES,
): Partial<Record<HostId, HostAdapter>> => {
  const adapters: Partial<Record<HostId, HostAdapter>> = {};
  for (const [host, factory] of Object.entries(factories) as [HostId, () => HostAdapter][])
    adapters[host] = factory();
  return adapters;
};

export interface BuildEnginePartsOptions {
  readonly repoRoot: string;
  readonly vtcHome: string;
  readonly installToken: string;
  readonly assets: AssetBundle;
  /**
   * Defaults: the runtime's storage driver, `gates.createGateRunner`, `ADAPTER_FACTORIES`, the
   * persisted wake scheduler and the `gh`-backed PR service (`ghCommand`, default `gh`).
   */
  readonly openStorage?: StorageFactory;
  readonly createGateRunner?: CreateGateRunner;
  readonly adapterFactories?: Readonly<Partial<Record<HostId, () => HostAdapter>>>;
  readonly scheduler?: AutoResumeScheduler;
  readonly pullRequests?: PullRequestService;
  readonly ghCommand?: string;
}

/** Builds every part `vtc engine --daemon` injects. Constructing them starts no process. */
export const buildEngineParts = async (options: BuildEnginePartsOptions): Promise<EngineParts> => {
  const { repoRoot, vtcHome } = options;
  const createGateRunner = options.createGateRunner ?? gates.createGateRunner;
  return {
    repoRoot,
    vtcHome,
    installToken: options.installToken,
    openStorage: options.openStorage ?? (await loadStorage()),
    gateRunner: lazyGateRunner(() =>
      createGateRunner({ repoRoot, vtcHome, git: git.createGitOps({ repoRoot }) }),
    ),
    adapters: createAdapters(options.adapterFactories),
    assets: options.assets,
    scheduler: options.scheduler ?? createWakeScheduler(vtcHome),
    pullRequests: options.pullRequests ?? git.createGhPullRequests(repoRoot, options.ghCommand),
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

/** The context every command runs with. The engine client connects lazily, once. */
export const createCommandContext = (
  io: CliIo,
  cwd: string,
  vtcHome: string,
  connect: () => Promise<EngineClient> = () => connectToRepoEngine(cwd, vtcHome),
): CommandContext => {
  let client: Promise<EngineClient> | undefined;
  return { io, cwd, vtcHome, engine: () => (client ??= connect()) };
};
