/**
 * Runs `git` with the user's own installation, configuration and auth (AD-9). Arguments are an
 * argv array, never a shell string. Hooks of the user's repo never run on engine commits.
 */
import { spawn } from "node:child_process";

export interface GitResult {
  readonly code: number;
  readonly stdout: Buffer;
  readonly stderr: string;
}

export class GitError extends Error {
  constructor(
    readonly args: readonly string[],
    readonly code: number,
    readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} failed (${String(code)}): ${stderr.trim().slice(0, 500)}`);
    this.name = "GitError";
  }
}

export interface GitRunOptions {
  /** Extra environment variables (merged over the process environment). */
  readonly env?: Readonly<Record<string, string>>;
  /** Resolve with the result instead of throwing on a non-zero exit. */
  readonly allowFailure?: boolean;
  readonly timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export const runGit = (
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: {
        ...process.env,
        // Never prompt (credentials, editors): the engine runs unattended.
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        code: code ?? -1,
        stdout: Buffer.concat(out),
        stderr: Buffer.concat(err).toString("utf8"),
      };
      if (result.code !== 0 && options.allowFailure !== true) {
        reject(new GitError(args, result.code, result.stderr));
      } else {
        resolve(result);
      }
    });
  });

/** stdout as trimmed text. */
export const gitText = async (
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<string> => (await runGit(cwd, args, options)).stdout.toString("utf8").trim();
