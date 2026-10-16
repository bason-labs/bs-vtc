/**
 * Owner: cli+binary team. Whether the repo's ignore rules keep `.vtc/project.yaml` or
 * `.vtc/gates.yml` out of git (spine §5 readings 79 and 265). A run starts only on their
 * committed copies, so a `.vtc/` line in `.gitignore` (the owner's first run) blocks every run.
 * Only `.vtc/state/`, the engine's local state, stays out of git: `vtc init` writes
 * `.vtc/.gitignore` for it, and the engine commits the rest of `.vtc/` at its milestones
 * (reading 90). `vtc doctor` and `vtc init` warn and name the line to change; neither edits it.
 */
import { core } from "@vtc/engine";
import { exec as defaultExec, type Exec } from "./process.js";

/** The two files a run reads at their committed copies. */
export const VTC_CONFIG_FILES: readonly string[] = [
  core.PROJECT_CONFIG_PATH,
  core.GATES_CONFIG_PATH,
];

/** What keeps the engine's local state out of git instead of ignoring all of `.vtc/`. */
export const VTC_LOCAL_IGNORE = ".vtc/state/";

export interface IgnoredVtcConfig {
  /** Repo-relative, e.g. `.vtc/project.yaml`. */
  readonly path: string;
  /** The ignore file the matching rule is in, as git names it (repo-relative or absolute). */
  readonly source: string;
  readonly line: number;
  readonly pattern: string;
}

/**
 * The config files an ignore rule matches, with that rule (`git check-ignore -v`). A tracked file
 * is not ignored (git keeps tracking it), and a `!` rule that matches last un-ignores it.
 */
export const ignoredVtcConfig = async (
  repoRoot: string,
  run: Exec = defaultExec,
): Promise<IgnoredVtcConfig[]> => {
  const found: IgnoredVtcConfig[] = [];
  for (const path of VTC_CONFIG_FILES) {
    const tracked = await run("git", ["ls-files", "--error-unmatch", "--", path], {
      cwd: repoRoot,
      timeoutMs: 5_000,
    });
    if (tracked.code === 0) continue;
    const check = await run("git", ["check-ignore", "-v", "--", path], {
      cwd: repoRoot,
      timeoutMs: 5_000,
    });
    if (check.code !== 0) continue;
    // `<source>:<line>:<pattern>\t<path>`; the source may itself hold a colon (a Windows path)
    const match = /^(.*):(\d+):(.*)\t/.exec(check.stdout.split("\n")[0] ?? "");
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) continue;
    if (match[3].startsWith("!")) continue;
    found.push({ path, source: match[1], line: Number(match[2]), pattern: match[3] });
  }
  return found;
};

/** The warning for {@link ignoredVtcConfig}'s findings: which rule, and what to use instead. */
export const vtcConfigIgnoredText = (ignored: readonly IgnoredVtcConfig[]): string => {
  const files = ignored.map((i) => i.path).join(" and ");
  const rules = [...new Set(ignored.map((i) => `${i.source}:${String(i.line)} \`${i.pattern}\``))];
  return `${files} ${ignored.length === 1 ? "is" : "are"} ignored by git (${rules.join(", ")}), but a run starts only on the committed ${ignored.length === 1 ? "copy" : "copies"}: replace that line with \`${VTC_LOCAL_IGNORE}\` (only the engine's local state stays out of git; .vtc/.gitignore from vtc init already ignores it), then commit .vtc/project.yaml and .vtc/gates.yml`;
};
