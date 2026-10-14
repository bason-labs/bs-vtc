/**
 * `HostAdapter.authStatus()` (AD-25 rule 3, AD-9): the host's login state, read only through the
 * host's own sanctioned status command (`claude auth status --json`, `codex login status`). Exit 0
 * means logged in. VTC never opens a credential file or the keychain; the command's output is
 * reduced to a fixed method label here and nothing else of it (account names, masked keys) is
 * passed on. A command that cannot start, is killed or hangs leaves the state unknown (`null`),
 * never `false`.
 */
import { homedir } from "node:os";
import {
  HostAuthStatusSchema,
  type HostAuthStatus,
  type HostCommand,
  type HostId,
} from "@vtc/shared";
import type { SpawnedProcess, Spawner } from "./process.js";

/** How one host reports its login. */
export interface AuthStatusCommand {
  readonly host: HostId;
  readonly command: HostCommand;
  /**
   * Pure: from a finished command's output, whether it says logged out despite exit 0 (`false`),
   * and the login method as a short label, or `null`.
   */
  readonly read: (output: { readonly stdout: string; readonly stderr: string }) => {
    readonly loggedOut: boolean;
    readonly method: string | null;
  };
}

export interface AuthStatusOptions {
  readonly spawner: Spawner;
  readonly now: () => Date;
  /** How long the status command may run before it is killed. Default 20 s. */
  readonly timeoutMs?: number;
  /**
   * The status command's working directory. Default: the user's home, which only the user can
   * write. Never the OS temp directory: other local users and roles (D-ag) can write there, and a
   * file planted in the working directory must never be what runs (§15).
   */
  readonly cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;
/** The most output read from a status command; the rest is dropped. */
const MAX_OUTPUT_CHARS = 16_000;

/** A method label as the host prints it ("claude.ai", "ChatGPT"): short and plain, or nothing. */
export const methodLabel = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/u.test(value) ? value : null;

/** How long to wait for the output to drain after the command exited. */
const DRAIN_MS = 1000;

/** Reads a stream's text (bounded) and resolves `done` when it ends or closes. */
const collect = (stream: NodeJS.ReadableStream) => {
  let text = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    if (text.length < MAX_OUTPUT_CHARS) text = (text + chunk).slice(0, MAX_OUTPUT_CHARS);
  });
  const done = new Promise<void>((resolve) => {
    stream.once("end", resolve);
    stream.once("close", resolve);
  });
  return { text: () => text, done };
};

/** Runs status commands and stops any still running on `dispose()` (§15: no orphans). */
export const createAuthStatusRunner = (options: AuthStatusOptions) => {
  const running = new Set<SpawnedProcess>();
  return {
    async check(status: AuthStatusCommand): Promise<HostAuthStatus> {
      const result = (logged_in: boolean | null, method: string | null): HostAuthStatus =>
        HostAuthStatusSchema.parse({
          host: status.host,
          logged_in,
          method: logged_in === true ? method : null,
          checked_at: options.now().toISOString(),
        });
      let child: SpawnedProcess;
      try {
        // a directory only the user can write, and no repo's: no planted file or repo settings
        // are anywhere near the status command
        child = options.spawner(status.command, { cwd: options.cwd ?? homedir(), stdin: "closed" });
      } catch {
        return result(null, null);
      }
      running.add(child);
      const stdout = collect(child.stdout);
      const stderr = collect(child.stderr);
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
      }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timer.unref();
      try {
        const exit = await child.exited;
        if (exit.error !== null || exit.code === null) return result(null, null);
        if (exit.code !== 0) return result(false, null);
        let drain: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.all([stdout.done, stderr.done]),
          new Promise<void>((resolve) => {
            drain = setTimeout(resolve, DRAIN_MS);
          }),
        ]);
        clearTimeout(drain);
        const read = status.read({ stdout: stdout.text(), stderr: stderr.text() });
        return read.loggedOut ? result(false, null) : result(true, read.method);
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
