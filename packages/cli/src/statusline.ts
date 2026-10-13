/**
 * `vtc statusline-tee -- <the user's statusline command>` (§6.9, spine §5 reading 6): the Claude
 * statusline shim. It wraps the user's own statusline command instead of replacing it: the
 * command gets Claude's statusline JSON on stdin unchanged and its output is printed unchanged.
 * Alongside, the shim turns the JSON into a `StatuslineIngest` with the adapter's pure
 * `statuslineIngestFromClaude` and POSTs it to the repo's running engine (found through the
 * discovery file, AD-12) with the install token (AD-5). Forwarding is best effort and silent: the
 * user's statusline never breaks because VTC is not running.
 */
import { spawn } from "node:child_process";
import { statuslineIngestFromClaude } from "@vtc/adapters";
import { ENGINE_HTTP, type EngineDiscovery, type StatuslineIngest } from "@vtc/shared";

export interface StatuslineDeps {
  readonly vtcHome: string;
  readonly cwd: string;
  readonly findRepoRoot: (cwd: string) => Promise<string | null>;
  readonly liveDaemon: (vtcHome: string, repoRoot: string) => EngineDiscovery | null;
  readonly readInstallToken: (vtcHome: string) => string;
  readonly post: (
    port: number,
    path: string,
    token: string,
    body: string,
  ) => Promise<{
    readonly status: number;
  }>;
  readonly runCommand: (command: string, stdin: string) => Promise<CommandOutput>;
}

export interface CommandOutput {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** The directory the Claude session works in, as its statusline JSON reports it. */
const sessionDir = (raw: unknown): string | undefined => {
  if (!isRecord(raw)) return undefined;
  const workspace = isRecord(raw.workspace) ? raw.workspace : {};
  const dir = workspace.current_dir ?? workspace.project_dir ?? raw.cwd;
  return typeof dir === "string" && dir !== "" ? dir : undefined;
};

/** Forwards the usage in `stdin` to the repo's engine; resolves `true` when the engine took it. */
export const forwardStatusline = async (stdin: string, deps: StatuslineDeps): Promise<boolean> => {
  try {
    const raw: unknown = JSON.parse(stdin);
    const body: StatuslineIngest | null = statuslineIngestFromClaude(raw);
    if (body === null) return false;
    const repoRoot = await deps.findRepoRoot(sessionDir(raw) ?? deps.cwd);
    if (repoRoot === null) return false;
    const daemon = deps.liveDaemon(deps.vtcHome, repoRoot);
    if (daemon === null) return false;
    const { status } = await deps.post(
      daemon.port,
      ENGINE_HTTP.routes.statuslineIngest.path,
      deps.readInstallToken(deps.vtcHome),
      JSON.stringify(body),
    );
    return status >= 200 && status < 300;
  } catch {
    return false;
  }
};

/** The user's command: every argument after `--`, joined as one shell command line. */
export const userCommandOf = (args: readonly string[]): string | null => {
  const at = args.indexOf("--");
  const words = at < 0 ? [] : args.slice(at + 1);
  return words.length === 0 ? null : words.join(" ");
};

/** Runs the shim: the user's statusline output (and exit code) unchanged, usage forwarded. */
export const runStatuslineTee = async (
  args: readonly string[],
  stdin: string,
  deps: StatuslineDeps,
): Promise<CommandOutput> => {
  const command = userCommandOf(args);
  const [, output] = await Promise.all([
    forwardStatusline(stdin, deps),
    command === null
      ? Promise.resolve<CommandOutput>({ code: 0, stdout: "", stderr: "" })
      : deps.runCommand(command, stdin),
  ]);
  return output;
};

/** Runs the user's statusline command through the shell, as Claude Code itself would. */
export const runShellCommand = (
  command: string,
  stdin: string,
  timeoutMs = 10_000,
): Promise<CommandOutput> =>
  new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}\n` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(stdin);
  });
