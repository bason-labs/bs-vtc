/**
 * Running a short-lived child process with a hard timeout (`git rev-parse`, `claude --version`,
 * `launchctl`). Never through a shell: the command and its arguments are passed as they are. The
 * one exception is Windows, where npm installs the host CLIs as `.cmd` shims that only `cmd.exe`
 * can run: such a shim runs through `cmd /d /s /c` and only with arguments that hold no shell
 * metacharacter (`windowsInvocation`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { win32 } from "node:path";

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
  options?: {
    readonly cwd?: string;
    readonly timeoutMs?: number;
    readonly input?: string;
    /** Variables set over the inherited environment. */
    readonly env?: Readonly<Record<string, string>>;
    /** `false`: `env` is the child's whole environment (nothing inherited). Default `true`. */
    readonly inheritEnv?: boolean;
  },
) => Promise<ExecResult>;

const MAX_OUTPUT = 1024 * 1024;

/** How a command runs on Windows: the file and argv to spawn, or why it cannot run safely. */
export type WindowsInvocation =
  | {
      readonly file: string;
      readonly args: readonly string[];
      /** Pass `args` to the process as written (`windowsVerbatimArguments`). */
      readonly verbatim: boolean;
    }
  | { readonly error: string };

/** Arguments a `.cmd` shim may receive through `cmd.exe`: no quote, `%`, `^`, `&`, `|`, `<`, `>`, `!` or space. */
const CMD_SAFE_ARG = /^[A-Za-z0-9_.,:/\\=@+-]+$/;

/**
 * Resolves a bare command name the way `cmd.exe` does (each `PATH` directory, each `PATHEXT`
 * extension) so a `.cmd`/`.bat` shim (npm's `claude.cmd`, `codex.cmd`) is found, and runs a shim
 * through `cmd /d /s /c` with strictly checked arguments. A name with a directory or an extension,
 * or one not found, is spawned as is.
 */
export const windowsInvocation = (
  command: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  exists: (path: string) => boolean = existsSync,
): WindowsInvocation => {
  const lookup = (name: string): string | undefined =>
    Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];
  const bare = !/[\\/]/.test(command) && win32.extname(command) === "";
  const exts = (lookup("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((e) => e !== "");
  const dirs = (lookup("PATH") ?? "").split(";").filter((d) => d !== "");
  const candidates = bare
    ? dirs.flatMap((dir) => exts.map((ext) => win32.join(dir, `${command}${ext.toLowerCase()}`)))
    : [];
  const file = candidates.find((c) => exists(c)) ?? command;
  if (!/\.(?:cmd|bat)$/i.test(file)) return { file, args, verbatim: false };
  if (/["%^!]/.test(file) || !args.every((a) => CMD_SAFE_ARG.test(a)))
    return { error: `refusing to run ${file} through cmd.exe with these arguments` };
  return {
    file: lookup("COMSPEC") ?? "cmd.exe",
    args: ["/d", "/s", "/c", `""${file}"${args.map((a) => ` ${a}`).join("")}"`],
    verbatim: true,
  };
};

export const exec: Exec = (command, args, options = {}) => {
  const invocation =
    process.platform === "win32"
      ? windowsInvocation(command, args, process.env)
      : { file: command, args, verbatim: false };
  if ("error" in invocation)
    return Promise.resolve({ code: null, stdout: "", stderr: "", error: invocation.error });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ExecResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(invocation.file, [...invocation.args], {
      cwd: options.cwd,
      ...(options.inheritEnv === false
        ? { env: { ...options.env } }
        : options.env === undefined
          ? {}
          : { env: { ...process.env, ...options.env } }),
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: invocation.verbatim,
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
};
