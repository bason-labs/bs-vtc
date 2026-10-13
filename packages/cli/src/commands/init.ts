/**
 * Owner: cli+binary team (sub-project 1); spec §4.3, §4.4 step 4. `vtc init [--concurrency 1-3]
 * [--force]` creates `.vtc/` in the current repo: `.vtc/project.yaml` with every spec default
 * written out (concurrency 2, at most 3; `hosts.dispatch: plugin_only`, AD-17) and
 * `.vtc/.gitignore`, which keeps `.vtc/state/` out of git (§4.3).
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { core } from "@vtc/engine";
import { ProjectConfigSchema, type ProjectConfig } from "@vtc/shared";
import { requireRepoRoot, UsageError } from "../repo.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const HEADER = [
  "# VTC project settings (spec §4.3). Every value below is the spec default; edit freely.",
  "# concurrency: parallel tasks, reviewers included (1 to 3).",
  "# hosts.dispatch: plugin_only runs every role as a subagent of your Lead session;",
  "#   headless_allowed also lets the engine start host CLIs itself (auto-resume without a Lead).",
  "",
].join("\n");

/** The defaults `vtc init` writes, validated by the frozen schema. */
export const defaultProjectConfig = (concurrency?: number): ProjectConfig => {
  const parsed = ProjectConfigSchema.safeParse({
    version: 1,
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  if (!parsed.success)
    throw new UsageError(
      `--concurrency must be a whole number from 1 to 3, got ${String(concurrency)}`,
    );
  return parsed.data;
};

export const renderProjectYaml = (config: ProjectConfig): string =>
  `${HEADER}${core.toYaml(config)}`;

export const command: CommandSpec = {
  name: "init",
  summary: "Create .vtc/ in this repo (project.yaml with the defaults)",
  run: (args, ctx) =>
    guarded("init", ctx, async () => {
      const { values } = parseFlags(args, {
        force: { type: "boolean", default: false },
        concurrency: { type: "string" },
      });
      const concurrency = values.concurrency === undefined ? undefined : Number(values.concurrency);
      const config = defaultProjectConfig(concurrency);
      const repoRoot = await requireRepoRoot(ctx.cwd);
      const path = join(repoRoot, core.PROJECT_CONFIG_PATH);
      if (existsSync(path) && !values.force) {
        ctx.io.err(`vtc init: ${path} exists; pass --force to overwrite it with the defaults`);
        return EXIT.failed;
      }
      mkdirSync(join(repoRoot, ".vtc"), { recursive: true });
      writeFileSync(path, renderProjectYaml(config));
      const ignore = join(repoRoot, ".vtc", ".gitignore");
      if (!existsSync(ignore)) writeFileSync(ignore, "# local engine state (§4.3)\n/state/\n");
      ctx.io.out(`Wrote ${path}`);
      ctx.io.out("Next: vtc calibrate, then /vtc start in Claude Code or Codex.");
      return EXIT.ok;
    }),
};
