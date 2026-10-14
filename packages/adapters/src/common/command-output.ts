/**
 * Short host commands whose whole output the adapter reads (`claude auth status --json`, `codex
 * login status`, `codex mcp list --json`): started through the {@link Spawner} with stdin closed,
 * killed after a timeout, their output bounded, and any still running stopped on `dispose()`
 * (§15: no orphans). Output is handed to the caller only; nothing here logs or keeps it.
 */
import type { HostCommand } from "@vtc/shared";
import type { SpawnedProcess, Spawner } from "./process.js";

/** What a short command left behind. */
export type CommandOutput =
  /** It could not start, was killed (timeout or `dispose()`), or exited by a signal. */
  | { readonly kind: "failed" }
  | {
      readonly kind: "exited";
      readonly code: number;
      readonly stdout: string;
      readonly stderr: string;
      /** Whether either stream said more than `maxChars` (the rest was dropped). */
      readonly truncated: boolean;
    };

export interface CommandOutputOptions {
  readonly spawner: Spawner;
  /** How long the command may run before it is killed. */
  readonly timeoutMs: number;
  /** The most text read from each stream. */
  readonly maxChars: number;
}

/** How long to wait for the output to drain after the command exited. */
const DRAIN_MS = 1000;

/** Reads a stream's text (bounded) and resolves `done` when it ends or closes. */
const collect = (stream: NodeJS.ReadableStream, maxChars: number) => {
  let text = "";
  let truncated = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (text.length + chunk.length > maxChars) truncated = true;
    if (text.length < maxChars) text = (text + chunk).slice(0, maxChars);
  });
  const done = new Promise<void>((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
  return { text: () => text, truncated: () => truncated, done };
};

export const createCommandOutputRunner = (options: CommandOutputOptions) => {
  const running = new Set<SpawnedProcess>();
  return {
    async run(command: HostCommand, cwd: string): Promise<CommandOutput> {
      let child: SpawnedProcess;
      try {
        child = options.spawner(command, { cwd, stdin: "closed" });
      } catch {
        return { kind: "failed" };
      }
      running.add(child);
      const stdout = collect(child.stdout, options.maxChars);
      const stderr = collect(child.stderr, options.maxChars);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs);
      timer.unref();
      try {
        const exit = await child.exited;
        if (exit.error !== null || exit.code === null) return { kind: "failed" };
        let drain: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all([stdout.done, stderr.done]),
          new Promise<void>((resolve) => {
            drain = setTimeout(resolve, DRAIN_MS);
          }),
        ]);
        clearTimeout(drain);
        return {
          kind: "exited",
          code: exit.code,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated() || stderr.truncated(),
        };
      } finally {
        clearTimeout(timer);
        running.delete(child);
      }
    },
    dispose(): void {
      for (const child of running) child.kill("SIGKILL");
    },
  };
};
