/**
 * @vtc/cli: the `vtc` command and the composition root (AD-1). It is the only package that
 * imports the engine, the adapters and the compiler together and picks the storage driver.
 */
import { HOST_CAPABILITIES } from "@vtc/adapters";
import { COMPILE_TARGETS } from "@vtc/compiler";
import { ENGINE_NAME } from "@vtc/engine";
import { CONTRACTS_VERSION } from "@vtc/shared";
import { COMMANDS } from "./commands/index.js";
import type { CommandContext } from "./commands/types.js";
import { VERSION } from "./wiring.js";

export { COMMANDS } from "./commands/index.js";
export type { CliIo, CommandContext, CommandSpec } from "./commands/types.js";
export { detectRuntime, loadStorage, type Runtime } from "./storage.js";
export { ensureInstallToken, installTokenPath, readInstallToken } from "./token.js";
export {
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
    ctx.io.out(
      `vtc ${VERSION} (${ENGINE_NAME}, contracts ${CONTRACTS_VERSION}, hosts ${Object.keys(HOST_CAPABILITIES).join("/")}, plugins ${Object.values(COMPILE_TARGETS).join(", ")})`,
    );
    return 0;
  }
  const spec = COMMANDS.find((c) => c.name === command);
  if (spec !== undefined) return spec.run(args, ctx);
  ctx.io.err(`vtc: unknown command '${command}'. Run 'vtc --help'.`);
  return 64;
};
