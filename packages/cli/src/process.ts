/**
 * Running a short-lived child process with a hard timeout (`git rev-parse`, `claude --version`,
 * `launchctl`). Never through a shell: the command and its arguments are passed as they are.
 */
import { spawn } from "node:child_process";

export interface ExecResult {
  /** Exit code; `null` when the process could not start, was killed or timed out. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Why the process did not produce an exit code (`ENOENT`, `timeout`…). */
  readonly error?: string;
}

/** Runs a command; stdout and stderr are each capped so a chatty tool cannot exhaust memory. */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: { readonly cwd?: string; readonly timeoutMs?: number; readonly input?: string },
) => Promise<ExecResult>;

const MAX_OUTPUT = 1024 * 1024;

export const exec: Exec = (command, args, options = {}) =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, error: "timeout" });
    }, options.timeoutMs ?? 15_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({ code: null, stdout, stderr, error: error.code ?? error.message });
    });
    child.on("close", (code) => {
      finish({ code, stdout, stderr });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
