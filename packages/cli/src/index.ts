/**
 * @vtc/cli: the `vtc` command and the composition root (AD-1). It is the only package that
 * imports the engine, the adapters and the compiler together and picks the storage driver.
 */
import { HOST_CAPABILITIES } from "@vtc/adapters";
import { COMPILE_TARGETS } from "@vtc/compiler";
import { ENGINE_NAME } from "@vtc/engine";
import { CONTRACTS_VERSION } from "@vtc/shared";

export const VERSION = "0.0.0";

/** Commands from spec §4.1 / §4.4. Each is implemented by the sub-project that owns it. */
export const COMMANDS = [
  { name: "init", summary: "Create .vtc/ in this repo" },
  { name: "calibrate", summary: "Detect the toolchain and freeze the gate baseline" },
  { name: "dashboard", summary: "Serve Flow Studio on 127.0.0.1" },
  { name: "pause", summary: "Kill switch: stop dispatching and merging" },
  { name: "resume", summary: "Resume a paused or interrupted run" },
  { name: "status", summary: "Show the current run" },
  { name: "install", summary: "Install the plugin for a host (claude-code | codex)" },
  { name: "doctor", summary: "Check prerequisites; download pinned browsers and scanners" },
  { name: "engine", summary: "Run the engine (--mcp for stdio MCP)" },
] as const;

export interface CliIo {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const helpText = (): string[] => [
  `vtc ${VERSION}`,
  "",
  "Usage: vtc <command> [options]",
  "",
  ...COMMANDS.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`),
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
