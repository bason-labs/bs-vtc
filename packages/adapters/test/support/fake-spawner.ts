/**
 * A scriptable stand-in for host processes: tests never start the real `claude` or `codex`.
 * Each spawn records its command and options; the test writes stdout lines and ends the process.
 */
import { PassThrough } from "node:stream";
import type { HostCommand } from "@vtc/shared";
import type { ProcessExit, SpawnedProcess, Spawner, SpawnOptions } from "../../src/index.js";

export class FakeProcess implements SpawnedProcess {
  readonly pid = 4242;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin: PassThrough | null;
  readonly signals: string[] = [];
  readonly exited: Promise<ProcessExit>;
  /** Whether SIGINT ends the process (Claude ends its turn on it; a stuck host ignores it). */
  obeysInt = true;
  /** Whether SIGTERM ends the process (a stuck host ignores it until SIGKILL). */
  obeysTerm = true;
  private settle: (exit: ProcessExit) => void = () => undefined;
  private done = false;

  constructor(
    readonly command: HostCommand,
    readonly options: SpawnOptions,
  ) {
    this.stdin = options.stdin === "pipe" ? new PassThrough() : null;
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  /** Everything written to stdin, once the writer has closed it. */
  stdinText(): Promise<string> {
    const stdin = this.stdin;
    if (stdin === null) return Promise.resolve("");
    return new Promise((resolve) => {
      let text = "";
      stdin.on("data", (chunk: Buffer) => (text += chunk.toString("utf8")));
      stdin.once("end", () => {
        resolve(text);
      });
    });
  }

  get finished(): boolean {
    return this.done;
  }

  emit(...lines: readonly string[]): void {
    for (const line of lines) this.stdout.write(`${line}\n`);
  }

  writeStderr(text: string): void {
    this.stderr.write(text);
  }

  exit(code: number | null, signal: string | null = null): void {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    this.stdin?.end();
    this.settle({ code, signal, error: null });
  }

  /** The process exits, but its stdout stays open (something it started still holds it). */
  settleOnly(code: number): void {
    if (this.done) return;
    this.done = true;
    this.settle({ code, signal: null, error: null });
  }

  failToStart(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    this.settle({ code: null, signal: null, error });
  }

  kill(signal: "SIGINT" | "SIGTERM" | "SIGKILL"): void {
    if (this.done) return;
    this.signals.push(signal);
    const obeys =
      signal === "SIGKILL" ||
      (signal === "SIGTERM" && this.obeysTerm) ||
      (signal === "SIGINT" && this.obeysInt);
    if (obeys) this.exit(null, signal);
  }
}

export const fakeSpawner = (onSpawn?: (process: FakeProcess) => void) => {
  const processes: FakeProcess[] = [];
  const spawner: Spawner = (command, options) => {
    const process = new FakeProcess(command, options);
    processes.push(process);
    onSpawn?.(process);
    return process;
  };
  return { spawner, processes };
};

/** Reads each JSON line a client writes to a fake process's stdin. */
export const onStdinMessage = (
  process: FakeProcess,
  handle: (message: Record<string, unknown>) => void,
): void => {
  let buffer = "";
  process.stdin?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (line.trim() !== "") handle(JSON.parse(line) as Record<string, unknown>);
      newline = buffer.indexOf("\n");
    }
  });
};

/** One entry of a fake `codex mcp list --json`. */
export interface FakeMcpServer {
  readonly name: string;
  readonly enabled: boolean;
}

const isCodexMcpList = (process: FakeProcess): boolean =>
  process.command.command === "codex" &&
  process.command.args[0] === "mcp" &&
  process.command.args[1] === "list";

/**
 * The servers a fake `codex mcp list --json` prints for `args`, as codex-cli 0.162.1 resolves
 * them (`test/fixtures/codex/mcp-isolation.json`): the configured ones, the engine bridge when
 * the overrides pin it, and each server an inline `mcp_servers={"<name>"={enabled=false}, …}`
 * override names, turned off.
 */
export const fakeMcpList = (
  servers: readonly FakeMcpServer[],
  args: readonly string[],
): FakeMcpServer[] => {
  const off = new Set<string>();
  for (const arg of args) {
    if (!arg.startsWith("mcp_servers={")) continue;
    for (const match of arg.matchAll(/("(?:[^"\\]|\\.)*")=\{enabled=false\}/gu)) {
      off.add(JSON.parse(match[1]!) as string);
    }
  }
  const bridge = args.some((arg) => arg.startsWith("mcp_servers.vtc.command="))
    ? [{ name: "vtc", enabled: true }]
    : [];
  return [...servers, ...bridge].map((server) =>
    off.has(server.name) ? { ...server, enabled: false } : server,
  );
};

/**
 * A fake spawner for the Codex adapter: each `codex mcp list --json` it is asked for (the MCP
 * isolation check before every headless run) is answered at once from `servers` (default: none)
 * and recorded in `mcpLists`, never in `processes`; `onMcpList` replaces that answer. Every other
 * command behaves as in {@link fakeSpawner}.
 */
export const codexFakeSpawner = (
  options: {
    readonly onSpawn?: (process: FakeProcess) => void;
    readonly servers?: readonly FakeMcpServer[];
    readonly onMcpList?: (process: FakeProcess) => void;
  } = {},
) => {
  const processes: FakeProcess[] = [];
  const mcpLists: FakeProcess[] = [];
  const spawner: Spawner = (command, spawnOptions) => {
    const process = new FakeProcess(command, spawnOptions);
    if (isCodexMcpList(process)) {
      mcpLists.push(process);
      if (options.onMcpList !== undefined) {
        options.onMcpList(process);
      } else {
        process.emit(JSON.stringify(fakeMcpList(options.servers ?? [], command.args)));
        process.exit(0);
      }
      return process;
    }
    processes.push(process);
    options.onSpawn?.(process);
    return process;
  };
  return { spawner, processes, mcpLists };
};
