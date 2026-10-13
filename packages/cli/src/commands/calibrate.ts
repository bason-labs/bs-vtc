/**
 * `vtc calibrate` (spec §7.1). Owner: gate-runner team (sub-project 2). Detects the toolchain,
 * asks the human to confirm every gate command before it runs (§15: the per-machine allowlist,
 * which only a human widens), runs each gate twice on `HEAD`, records flaky tests and freezes the
 * baseline in `.vtc/gates.yml`. Confirmation needs an interactive terminal, so an agent's shell
 * can run detection but never confirm. The logic is `gates.calibrate` in the engine package.
 * Every gate command runs in the gate sandbox (D-al); `gates.allow_unsandboxed` is read from the
 * user config in the VTC home only, never from the repo.
 */
import { createInterface } from "node:readline";
import { gates, git } from "@vtc/engine";
import { gatesAllowUnsandboxed } from "@vtc/shared";
import { readUserConfig } from "../user-config.js";
import type { CommandSpec } from "./types.js";

/** Exit code when the human did not confirm (or could not: no terminal). */
export const EXIT_NOT_CONFIRMED = 3;

const USAGE = [
  "usage: vtc calibrate [--dry-run]",
  "  --dry-run  print the detected gates as .vtc/gates.yml would hold them; run and write nothing",
];

const interactive = (): boolean => process.stdin.isTTY && process.stdout.isTTY;

/** A yes/no question on the terminal; `false` without one (agents and CI cannot confirm). */
const askTerminal = (question: string): Promise<boolean> => {
  if (!interactive()) return Promise.resolve(false);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise<boolean>((resolve) => {
    rl.question(`${question} [y/N] `, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
};

export const command: CommandSpec = {
  name: "calibrate",
  summary: "Detect the toolchain and freeze the gate baseline",
  run: async (args, ctx) => {
    const unknown = args.filter((a) => a !== "--dry-run" && a !== "--help" && a !== "-h");
    if (unknown.length > 0) {
      for (const line of USAGE) ctx.io.err(line);
      return 1;
    }
    if (args.includes("--help") || args.includes("-h")) {
      for (const line of USAGE) ctx.io.out(line);
      return 0;
    }
    let repoRoot: string;
    let revision: string;
    try {
      repoRoot = await git.gitText(ctx.cwd, ["rev-parse", "--show-toplevel"]);
      revision = await git.gitText(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]);
    } catch {
      ctx.io.err("vtc calibrate: run it inside a git repository with at least one commit");
      return 1;
    }
    const userConfig = readUserConfig(ctx.vtcHome);
    if (!userConfig.ok) {
      // Fail closed: an unreadable config never turns the opt-in on.
      ctx.io.err(`vtc calibrate: ignoring ${userConfig.path}: ${userConfig.error}`);
    }
    try {
      const outcome = await gates.calibrate(
        {
          repoRoot,
          vtcHome: ctx.vtcHome,
          git: git.createGitOps({ repoRoot }),
          revision,
          out: ctx.io.out,
          confirm: askTerminal,
          allowUnsandboxed: userConfig.ok && gatesAllowUnsandboxed(userConfig.config),
        },
        { dryRun: args.includes("--dry-run") },
      );
      switch (outcome.status) {
        case "dry_run":
          for (const line of outcome.yaml.trimEnd().split("\n")) ctx.io.out(line);
          return 0;
        case "frozen":
          return 0;
        case "commands_not_confirmed":
        case "not_frozen":
          if (!interactive()) {
            ctx.io.err(
              "vtc calibrate: confirming needs an interactive terminal; run it yourself in one",
            );
          }
          return EXIT_NOT_CONFIRMED;
      }
    } catch (error) {
      ctx.io.err(`vtc calibrate: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  },
};
