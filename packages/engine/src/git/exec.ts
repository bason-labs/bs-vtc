/**
 * Runs `git` with the user's own installation, configuration and auth (AD-9), in a clean,
 * controlled environment (`gitEnv`) with explicit config overrides (spine §5 readings 22 and
 * 23). Arguments are an argv array, never a shell string. Engine git calls run unattended, so no
 * hook of the repo runs on them (`core.hooksPath` points at an empty location; `--no-verify`
 * alone skips only pre-commit, commit-msg and pre-merge-commit), no fsmonitor daemon starts, no
 * `ext::` transport runs, and no commit or tag is signed unless the project asks for it
 * (`git.sign_commits`, {@link setGitSigning}: then the user's own signing setup signs). The one
 * exception to the hook rule is `push` ({@link GitRunOptions.hooks}): a user's pre-push hook
 * guards what leaves the machine. Filter, merge and diff drivers have names chosen by the config
 * itself, so no `-c` can switch them all off; the held git configuration is fingerprinted
 * instead while any role is in flight, and a change stops engine git: {@link setGitPreflight}
 * runs before every git command in the repo (status runs clean filters too), the Gate Runner's
 * included.
 */
import { spawn } from "node:child_process";
import { sep } from "node:path";
import { gitEnv } from "./env.js";

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
  /** Extra environment variables (over the clean engine environment). */
  readonly env?: Readonly<Record<string, string>>;
  /** Resolve with the result instead of throwing on a non-zero exit. */
  readonly allowFailure?: boolean;
  readonly timeoutMs?: number;
  /** Run the repo's hooks (only `push`, see the module doc). Default `false`. */
  readonly hooks?: boolean;
  /**
   * Leave commit and tag signing to the user's own git configuration: no `commit.gpgsign` /
   * `tag.gpgsign` override (the automation plumbing, AD-27 rule 1). Default `false`.
   */
  readonly userSigning?: boolean;
}

const preflights = new Map<string, () => void>();
const signing = new Map<string, () => boolean>();

const under = (root: string, cwd: string): boolean =>
  cwd === root || cwd.startsWith(`${root}${sep}`);

/**
 * Registers a check that runs before every git command whose working directory is `root` or
 * below it (`null` removes it). When the check throws, the command is not run and `runGit`
 * rejects with that error.
 */
export const setGitPreflight = (root: string, check: (() => void) | null): void => {
  if (check === null) preflights.delete(root);
  else preflights.set(root, check);
};

/**
 * Whether engine commits and merges under `root` are signed with the user's signing setup
 * (`project.yaml` `git.sign_commits`, spine §5 reading 22); `null` removes it (never sign).
 */
export const setGitSigning = (root: string, sign: (() => boolean) | null): void => {
  if (sign === null) signing.delete(root);
  else signing.set(root, sign);
};

const runPreflights = (cwd: string): void => {
  for (const [root, check] of preflights) if (under(root, cwd)) check();
};

const signs = (cwd: string): boolean => {
  for (const [root, sign] of signing) if (under(root, cwd)) return sign();
  return false;
};

/** `-c` overrides on every engine git call (see the module doc). */
const NO_HOOKS = ["-c", `core.hooksPath=${process.platform === "win32" ? "NUL" : "/dev/null"}`];
const ALWAYS = ["-c", "core.fsmonitor=false", "-c", "protocol.ext.allow=never"];
const signingArgs = (sign: boolean): string[] => [
  "-c",
  `commit.gpgsign=${String(sign)}`,
  "-c",
  `tag.gpgsign=${String(sign)}`,
];

const DEFAULT_TIMEOUT_MS = 120_000;

export const runGit = (
  cwd: string,
  args: readonly string[],
  options: GitRunOptions = {},
): Promise<GitResult> =>
  new Promise((resolve, reject) => {
    runPreflights(cwd);
    const child = spawn(
      "git",
      [
        ...(options.hooks === true ? [] : NO_HOOKS),
        ...ALWAYS,
        ...(options.userSigning === true ? [] : signingArgs(signs(cwd))),
        ...args,
      ],
      { cwd, env: gitEnv(options.env), stdio: ["ignore", "pipe", "pipe"] },
    );
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
