/**
 * @vtc/cli: the `vtc` command and the composition root (AD-1). It is the only package that
 * imports the engine, the adapters and the compiler together and picks the storage driver.
 */
import { HOST_CAPABILITIES } from "@vtc/adapters";
import { COMPILE_TARGETS } from "@vtc/compiler";
import { ENGINE_NAME } from "@vtc/engine";
import { CONTRACTS_VERSION } from "@vtc/shared";
import { COMMANDS } from "./commands/index.js";

export const VERSION = "0.0.0";

export { COMMANDS, type CommandSpec } from "./commands/index.js";
export { detectRuntime, loadStorage, type Runtime } from "./storage.js";

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const helpText = (): string[] => [
  `vtc ${VERSION}`,
  "",
  "Usage: vtc <command> [options]",
  "",
  ...COMMANDS.map((c) => `  ${c.name.padEnd(15)} ${c.summary}`),
];

/** Entry point. Returns the process exit code. */
export const main = (argv: readonly string[], io: CliIo): number => {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    helpText().forEach((line) => {
      io.out(line);
    });
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out(
      `vtc ${VERSION} (${ENGINE_NAME}, contracts ${CONTRACTS_VERSION}, hosts ${Object.keys(HOST_CAPABILITIES).join("/")}, plugins ${Object.values(COMPILE_TARGETS).join(", ")})`,
    );
    return 0;
  }
  if (COMMANDS.some((c) => c.name === command)) {
    io.err(`vtc ${command}: not implemented yet`);
    return 2;
  }
  io.err(`vtc: unknown command '${command}'. Run 'vtc --help'.`);
  return 64;
};
