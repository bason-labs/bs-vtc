/**
 * Owner: cli+binary team. The Claude statusline tee shim (§6.9, spine §5 readings 6 and 61):
 * exactly `vtc statusline-tee [-- '<the user's statusline command>']`, the frozen
 * `STATUSLINE_TEE` form the Claude adapter's `install` writes with `statuslineTeeCommand` (the
 * user's command shell-quoted as one word). It runs that word through the shell once with the same
 * stdin, prints its output unchanged, and forwards `statuslineIngestFromClaude(stdin)` to the
 * running engine found through the discovery file (AD-12) with the install token
 * (`statusline.ts`), whatever the arguments.
 */
import { liveDaemon } from "../daemon.js";
import { postToEngine } from "../engine-http.js";
import { findRepoRoot } from "../repo.js";
import { runShellCommand, runStatuslineTee, type StatuslineDeps } from "../statusline.js";
import { readInstallToken } from "../token.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { readStdin } from "./util.js";

/**
 * The user's command gets stdin unchanged (§6.9), so it is read whole; the forwarding has its own
 * cap (`MAX_FORWARD_BYTES`). This bound only stops a runaway producer.
 */
const MAX_STDIN = 64 * 1024 * 1024;

export interface StatuslineCommandDeps {
  readonly stdin: () => Promise<string | null>;
  readonly write: (stdout: string, stderr: string) => void;
  readonly deps: (ctx: CommandContext) => StatuslineDeps;
}

export const defaultStatuslineCommandDeps = (): StatuslineCommandDeps => ({
  stdin: () => readStdin(MAX_STDIN, 5_000),
  write: (stdout, stderr) => {
    if (stdout !== "") process.stdout.write(stdout);
    if (stderr !== "") process.stderr.write(stderr);
  },
  deps: (ctx) => ({
    vtcHome: ctx.vtcHome,
    cwd: ctx.cwd,
    findRepoRoot: (cwd) => findRepoRoot(cwd),
    liveDaemon: (vtcHome, repoRoot) => liveDaemon(vtcHome, repoRoot),
    readInstallToken,
    post: postToEngine,
    runCommand: runShellCommand,
  }),
});

export const createStatuslineTeeCommand = (
  make: () => StatuslineCommandDeps = defaultStatuslineCommandDeps,
): CommandSpec => ({
  name: "statusline-tee",
  summary: "Claude statusline shim: show the user's statusline, forward usage to the engine",
  run: async (args, ctx) => {
    const d = make();
    const stdin = (await d.stdin()) ?? "";
    const output = await runStatuslineTee(args, stdin, d.deps(ctx));
    d.write(output.stdout, output.stderr);
    return output.code;
  },
});

export const command = createStatuslineTeeCommand();
