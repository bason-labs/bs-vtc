/**
 * Composition (AD-1 rule 4, AD-19; owner: cli+binary team). The only place that builds the
 * daemon's dependencies: the storage driver for this runtime, the Gate Runner, the host
 * adapters, the asset bundle and the auto-resume timer.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { ENGINE_NAME, runDaemon } from "@vtc/engine";
import {
  CONTRACTS_VERSION,
  type AssetBundle,
  type AutoResumeScheduler,
  type DaemonOptions,
  type EngineClient,
  type EngineDeps,
  type GateRunner,
  type HostAdapter,
  type HostId,
  type RunningDaemon,
  type StorageFactory,
} from "@vtc/shared";
import type { CliIo, CommandContext } from "./commands/types.js";

export const VERSION = "0.0.0";

/** The parts the cli constructs; `composeEngineDeps` turns them into `EngineDeps`. */
export interface EngineParts {
  readonly repoRoot: string;
  readonly vtcHome: string;
  readonly openStorage: StorageFactory;
  readonly gateRunner: GateRunner;
  readonly adapters: Readonly<Partial<Record<HostId, HostAdapter>>>;
  readonly assets: AssetBundle;
  readonly scheduler: AutoResumeScheduler;
}

export const composeEngineDeps = (parts: EngineParts): EngineDeps => ({
  ...parts,
  versions: { engine: `${ENGINE_NAME}@${VERSION}`, contracts: CONTRACTS_VERSION },
});

/** `vtc engine --daemon`: the engine-core team's `runDaemon` with the cli's wiring. */
export const startDaemon = (parts: EngineParts, options: DaemonOptions): Promise<RunningDaemon> =>
  runDaemon(composeEngineDeps(parts), options);

/** `$VTC_HOME`, or `~/.vtc`. */
export const resolveVtcHome = (env: Readonly<Record<string, string | undefined>>): string =>
  env.VTC_HOME ?? join(homedir(), ".vtc");

/** The context every command runs with. The engine client connects lazily, once. */
export const createCommandContext = (
  io: CliIo,
  cwd: string,
  vtcHome: string,
  connect: () => Promise<EngineClient> = () =>
    Promise.reject(new Error("the daemon client is not implemented yet (cli, sub-project 1)")),
): CommandContext => {
  let client: Promise<EngineClient> | undefined;
  return { io, cwd, vtcHome, engine: () => (client ??= connect()) };
};
