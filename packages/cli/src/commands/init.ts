/**
 * Owner: cli+binary team (sub-project 1); spec §4.3, §4.4 step 4. `vtc init [--concurrency 1-3]
 * [--force]` creates `.vtc/` in the current repo: `.vtc/project.yaml` with every spec default
 * written out (concurrency 2, at most 3; `hosts.dispatch: plugin_only`, AD-17) and
 * `.vtc/.gitignore`, which keeps `.vtc/state/` out of git (§4.3). A cloned repo can plant `.vtc`
 * or either file as a symlink pointing anywhere, so init refuses symlinks and anything that is not
 * a plain directory or file, and never writes through a link: new files are created exclusively
 * and `--force` replaces the file by renaming a fresh one over it.
 */
import { lstatSync, mkdirSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
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

const lstat = (path: string): Stats | null => {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/** The entry at `path` when it is of the expected kind, `null` when absent; throws otherwise. */
const plain = (path: string, kind: "file" | "directory"): Stats | null => {
  const stat = lstat(path);
  if (stat === null) return null;
  if (stat.isSymbolicLink())
    throw new Error(`${path} is a symbolic link; vtc init does not follow it`);
  if (kind === "file" ? !stat.isFile() : !stat.isDirectory())
    throw new Error(`${path} exists and is not a ${kind}`);
  return stat;
};

/** Writes `text` to `path` without following a link: a temp file created exclusively, renamed. */
const writeReplacing = (path: string, text: string): void => {
  const temp = `${path}.${String(process.pid)}.tmp`;
  rmSync(temp, { force: true });
  writeFileSync(temp, text, { flag: "wx" });
  renameSync(temp, path);
};

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
      const dir = join(repoRoot, ".vtc");
      const path = join(repoRoot, core.PROJECT_CONFIG_PATH);
      const ignore = join(dir, ".gitignore");
      const hasDir = plain(dir, "directory") !== null;
      const hasConfig = hasDir && plain(path, "file") !== null;
      const hasIgnore = hasDir && plain(ignore, "file") !== null;
      if (hasConfig && !values.force) {
        ctx.io.err(`vtc init: ${path} exists; pass --force to overwrite it with the defaults`);
        return EXIT.failed;
      }
      if (!hasDir) mkdirSync(dir);
      writeReplacing(path, renderProjectYaml(config));
      if (!hasIgnore)
        writeFileSync(ignore, "# local engine state (§4.3)\n/state/\n", { flag: "wx" });
      ctx.io.out(`Wrote ${path}`);
      ctx.io.out("Next: vtc calibrate, then /vtc start in Claude Code or Codex.");
      return EXIT.ok;
    }),
};
