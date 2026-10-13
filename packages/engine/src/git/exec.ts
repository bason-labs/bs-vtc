/**
 * Runs `git` with the user's own installation, configuration and auth (AD-9). Arguments are an
 * argv array, never a shell string. Engine git calls run unattended, so no hook of the repo runs
 * on them (`core.hooksPath` points at an empty location; `--no-verify` alone skips only
 * pre-commit, commit-msg and pre-merge-commit), no fsmonitor daemon is started and no commit or
 * tag is signed (`gpg.program` would be a command taken from the repo's config). The one
 * exception is `push` ({@link GitRunOptions.hooks}): a user's pre-push hook guards what leaves
 * the machine. Filter, merge and diff drivers have names chosen by the config itself, so no
 * `-c` can switch them all off; the repo's config files are fingerprinted instead while a role
 * works in the user's checkout, and a change stops engine git: {@link setGitPreflight} runs before
 * every git command in the repo (status runs clean filters too), the Gate Runner's included.
 */
import { spawn } from "node:child_process";
import { sep } from "node:path";

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
  /** Run the repo's hooks (only `push`, see the module doc). Default `false`. */
  readonly hooks?: boolean;
}

const preflights = new Map<string, () => void>();

/**
 * Registers a check that runs before every git command whose working directory is `root` or
 * below it (`null` removes it). When the check throws, the command is not run and `runGit`
 * rejects with that error.
 */
export const setGitPreflight = (root: string, check: (() => void) | null): void => {
  if (check === null) preflights.delete(root);
  else preflights.set(root, check);
};

const runPreflights = (cwd: string): void => {
  for (const [root, check] of preflights) {
    if (cwd === root || cwd.startsWith(`${root}${sep}`)) check();
  }
};

/** `-c` overrides on every engine git call: no hooks, no fsmonitor, no signing program. */
const NO_HOOKS = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`];
const ALWAYS = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "tag.gpgsign=false",
];

const DEFAULT_TIMEOUT_MS = 120_000;

export const runGit = (
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    runPreflights(cwd);
    const child = spawn("git", [...(options.hooks === true ? [] : NO_HOOKS), ...ALWAYS, ...args], {
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
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // Settles at once on a timeout: a grandchild (ssh, a credential helper) may hold the pipes.
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
      const timedOut = {
        code: -1,
        stdout: Buffer.alloc(0),
        stderr: `timed out after ${String(timeoutMs)} ms`,
      };
      if (options.allowFailure === true) resolve(timedOut);
      else reject(new GitError(args, -1, timedOut.stderr));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
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

const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` exclusively for one repository: worktree creation, commits, rebases, merges and
 * pushes touch shared files under `.git/` (worktree list, refs, config), so concurrent jobs of
 * one engine take turns.
 */
export const withRepoLock = <T>(repoRoot: string, fn: () => Promise<T>): Promise<T> => {
  const previous = repoLocks.get(repoRoot) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const settled = next.catch(() => undefined);
  repoLocks.set(repoRoot, settled);
  void settled.then(() => {
    if (repoLocks.get(repoRoot) === settled) repoLocks.delete(repoRoot);
  });
  return next;
};
