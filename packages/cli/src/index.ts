/**
 * @vtc/cli: the `vtc` command and the composition root (AD-1). It is the only package that
 * imports the engine, the adapters and the compiler together and picks the storage driver.
 */
import { COMMANDS } from "./commands/index.js";
import type { CommandContext } from "./commands/types.js";
import { versionLine } from "./commands/version.js";
import { VERSION } from "./version.js";
import { createCommandContext, resolveVtcHome } from "./wiring.js";

export { COMMANDS } from "./commands/index.js";
export type { CliIo, CommandContext, CommandSpec } from "./commands/types.js";
export { versionLine } from "./commands/version.js";
export {
  createDiskAssetBundle,
  createEmbeddedAssetBundle,
  devAssetRoots,
  extractNamespace,
  type EmbeddedAssetFiles,
} from "./assets.js";
export { ensureDaemon, liveDaemon } from "./daemon.js";
export { findRepoRoot } from "./repo.js";
export {
  binaryRuntime,
  configureRuntime,
  devRuntime,
  runtime,
  type CliRuntime,
} from "./runtime.js";
export { createWakeScheduler, dueWakeups } from "./scheduler.js";
export { detectRuntime, loadStorage, type Runtime } from "./storage.js";
export { ensureInstallToken, installTokenPath, readInstallToken } from "./token.js";
export {
  buildEngineParts,
  composeEngineDeps,
  createCommandContext,
  resolveVtcHome,
  startDaemon,
  VERSION,
  type EngineParts,
} from "./wiring.js";

const helpText = (): string[] => [
  `vtc ${VERSION}`,
  "",
  "Usage: vtc <command> [options]",
  "",
  ...COMMANDS.map((c) => `  ${c.name.padEnd(15)} ${c.summary}`),
];

/** Entry point. Resolves to the process exit code. */
export const main = async (argv: readonly string[], ctx: CommandContext): Promise<number> => {
  const [command, ...args] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    helpText().forEach((line) => {
      ctx.io.out(line);
    });
    return 0;
  }
  if (command === "--version" || command === "-v") {
    ctx.io.out(versionLine());
    return 0;
  }
  const spec = COMMANDS.find((c) => c.name === command);
  if (spec !== undefined) return spec.run(args, ctx);
  ctx.io.err(`vtc: unknown command '${command}'. Run 'vtc --help'.`);
  return 64;
};

/**
 * Runs `vtc` as a process: the runtime is already configured by the entry point. Resolves the
 * exit code; a command that leaves nothing running lets the process end on its own.
 */
export const runProcess = async (argv: readonly string[]): Promise<number> => {
  const ctx = createCommandContext(
    {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    process.cwd(),
    resolveVtcHome(process.env),
  );
  try {
    return await main(argv, ctx);
  } catch (error) {
    process.stderr.write(`vtc: ${error instanceof Error ? error.message : String(error)}\n`);
    return 70;
  }
};
