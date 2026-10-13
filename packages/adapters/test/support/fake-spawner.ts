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

  failToStart(error: Error): void {
    if (this.done) return;
    this.done = true;
    this.stdout.end();
    this.stderr.end();
    this.settle({ code: null, signal: null, error });
  }

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    if (this.done) return;
    this.signals.push(signal);
    if (signal === "SIGKILL" || this.obeysTerm) this.exit(null, signal);
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
