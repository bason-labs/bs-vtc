/**
 * The `gh` command the automatic issue and PR services run (AD-27 rule 1): the user's own `gh`
 * login (no token is ever read), `GH_PROMPT_DISABLED=1`, and an argv guard that runs before every
 * spawn. The guard is an allowlist: only the subcommands the services need, `-R owner/name` on
 * every repo command, bodies only through `--body-file` (a neutral relative name inside the
 * per-action staging directory), and never `GH_FORBIDDEN_ARGS`, `pr merge`, `--auto`, a force
 * flag, `gh api` or a repo-setting change.
 */
import { spawn } from "node:child_process";
import { EvidenceFileNameSchema, findForbiddenGhArgs, GitHubRepoSchema } from "@vtc/shared";

export interface GhResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs `gh <args>` in `cwd` (the per-action staging directory, so relative names resolve there). */
export type GhCommand = (args: readonly string[], cwd: string) => Promise<GhResult>;

/** A `gh` call that hangs on the network is killed. */
export const GH_TIMEOUT_MS = 120_000;

export class GhArgvRefusedError extends Error {
  constructor(message: string) {
    super(`gh argv refused: ${message}`);
    this.name = "GhArgvRefusedError";
  }
}

/** The only `gh` subcommands the upstream module runs (AD-27 rule 1). */
const ALLOWED_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  issue: ["list", "view", "create", "edit", "comment", "close", "reopen"],
  pr: ["list", "view", "create", "edit", "comment", "ready", "close"],
  label: ["list", "create"],
  repo: ["view"],
  auth: ["status"],
};

/** Commands that name a repo and therefore must carry an explicit `-R owner/name`. */
const REPO_COMMANDS = new Set(["issue", "pr", "label"]);

/** Flags whose value is a file in the staging directory. */
const FILE_FLAGS = new Set(["--body-file", "--attach"]);

/** A body file: a neutral relative name, never a user path. */
const BODY_FILE_NAME = /^[a-z0-9][a-z0-9_-]{0,40}\.md$/;

/**
 * Flags the services may pass. Anything else that looks like a flag is refused, which keeps out
 * `--body`/`--comment` on argv, `--auto`, `--force*`, `--admin`, `--fill`, short flags and
 * anything a later `gh` adds.
 */
const ALLOWED_FLAGS = new Set([
  "-R",
  "--json",
  "--label",
  "--state",
  "--limit",
  "--title",
  "--body-file",
  "--attach",
  "--draft",
  "--base",
  "--head",
  "--reason",
  "--color",
  "--description",
  "--add-label",
  "--delete-branch",
  "--version",
]);

/** Flags that take no value. */
const BOOLEAN_FLAGS = new Set(["--draft", "--delete-branch", "--version"]);

/**
 * Pure: throws {@link GhArgvRefusedError} unless `args` is a call the upstream module may make.
 * Runs before every spawn.
 */
export const assertGhArgsAllowed = (args: readonly string[]): void => {
  const forbidden = findForbiddenGhArgs(args);
  if (forbidden.length > 0) throw new GhArgvRefusedError(`forbidden ${forbidden.join(", ")}`);
  if (args.length === 1 && args[0] === "--version") return;
  const [command = "", sub = ""] = args;
  if (command === "pr" && sub === "merge") throw new GhArgvRefusedError("VTC never merges");
  if (args.some((a) => a === "--auto" || a.startsWith("--auto="))) {
    throw new GhArgvRefusedError("VTC never enables auto-merge");
  }
  if (args.some((a) => /^--force/.test(a))) throw new GhArgvRefusedError("no force flags");
  const subs = ALLOWED_SUBCOMMANDS[command];
  if (subs === undefined || !subs.includes(sub)) {
    throw new GhArgvRefusedError(`${command} ${sub} is not an automation command`);
  }
  let repo: string | undefined;
  for (let i = 2; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) continue;
    const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (!ALLOWED_FLAGS.has(name)) throw new GhArgvRefusedError(`flag ${name} is not allowed`);
    if (BOOLEAN_FLAGS.has(name)) continue;
    if (arg.includes("=")) throw new GhArgvRefusedError(`use ${name} <value>, not ${name}=`);
    const value = args[i + 1];
    if (value === undefined) throw new GhArgvRefusedError(`${name} needs a value`);
    i += 1;
    if (name === "-R") {
      if (!GitHubRepoSchema.safeParse(value).success) {
        throw new GhArgvRefusedError("-R must be owner/name");
      }
      repo = value;
    }
    if (FILE_FLAGS.has(name)) {
      const ok =
        name === "--body-file"
          ? BODY_FILE_NAME.test(value)
          : EvidenceFileNameSchema.safeParse(value).success;
      if (!ok) throw new GhArgvRefusedError(`${name} must name a neutral staging file`);
    }
  }
  if (args.includes("--delete-branch") && !(command === "pr" && sub === "close")) {
    throw new GhArgvRefusedError("--delete-branch only on pr close");
  }
  if (command === "repo" && !GitHubRepoSchema.safeParse(args[2]).success) {
    throw new GhArgvRefusedError("repo view needs an explicit owner/name");
  }
  if (REPO_COMMANDS.has(command) && repo === undefined) {
    throw new GhArgvRefusedError("repo commands need an explicit -R owner/name");
  }
};

/** `gh` stderr that means GitHub's secondary rate limit (AD-27 rule 1). */
export const isSecondaryRateLimit = (stderr: string): boolean =>
  /secondary rate limit|submitted too quickly|abuse detection/i.test(stderr);

export interface GhCommandOptions {
  /** The `gh` binary; tests pass a stub that records argv and serves canned JSON (D-cc). */
  readonly command?: string;
  readonly timeoutMs?: number;
}

/** The spawn-backed {@link GhCommand}: guard first, then `gh` with `GH_PROMPT_DISABLED=1`. */
export const createGhCommand = (options: GhCommandOptions = {}): GhCommand => {
  const command = options.command ?? "gh";
  const timeoutMs = options.timeoutMs ?? GH_TIMEOUT_MS;
  return (args, cwd) => {
    assertGhArgsAllowed(args);
    return new Promise((resolve, reject) => {
      const child = spawn(command, [...args], {
        cwd,
        env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ code: -1, stdout: "", stderr: `gh timed out after ${String(timeoutMs)} ms` });
      }, timeoutMs);
      child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
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
        resolve({ code: code ?? -1, stdout, stderr });
      });
    });
  };
};
