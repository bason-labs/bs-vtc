/**
 * AD-15 ownership map (`tooling/ownership.json`): pure matching, plus the repo's file list.
 * Runs under Vitest and under `node --experimental-strip-types` (`pnpm verify:scope`), so it uses
 * only Node built-ins and erasable TypeScript.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface OwnershipMap {
  readonly teams: Readonly<Record<string, readonly string[]>>;
  /**
   * Files a tool rewrites on any branch (`pnpm-lock.yaml`): still owned by one team, but any team
   * may change them, and nobody hand-merges them (AD-15 rule 2).
   */
  readonly regenerated?: readonly string[];
}

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export const loadOwnership = (): OwnershipMap =>
  JSON.parse(
    readFileSync(new URL("../../ownership.json", import.meta.url), "utf8"),
  ) as OwnershipMap;

/** Glob → anchored RegExp: `**` spans directories, `*` and `?` stay within one segment. */
export const globToRegExp = (glob: string): RegExp => {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      const slash = glob.charAt(i + 2) === "/";
      out += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`);
};

const matchers = new Map<string, RegExp>();
const matches = (glob: string, path: string): boolean => {
  let re = matchers.get(glob);
  if (re === undefined) {
    re = globToRegExp(glob);
    matchers.set(glob, re);
  }
  return re.test(path);
};

/** True when `path` matches one of the team's globs and none of its `!` exclusions. */
export const teamOwns = (globs: readonly string[], path: string): boolean =>
  globs.some((g) => !g.startsWith("!") && matches(g, path)) &&
  !globs.some((g) => g.startsWith("!") && matches(g.slice(1), path));

/**
 * The files of `changed` that `team` may not change: neither owned by it nor `regenerated`.
 * What `pnpm verify:scope` fails on.
 */
export const scopeViolations = (
  map: OwnershipMap,
  team: string,
  changed: readonly string[],
): string[] => {
  const globs = map.teams[team] ?? [];
  const regenerated = map.regenerated ?? [];
  return changed.filter(
    (path) => !teamOwns(globs, path) && !regenerated.some((glob) => matches(glob, path)),
  );
};

/** Every team that owns `path` (exactly one, when the map is correct). */
export const ownersOf = (map: OwnershipMap, path: string): string[] =>
  Object.entries(map.teams)
    .filter(([, globs]) => teamOwns(globs, path))
    .map(([team]) => team);

const git = (args: readonly string[]): string[] =>
  execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" })
    .split("\n")
    .filter((line) => line !== "");

/** Tracked files plus new files not ignored by .gitignore. */
export const repoFiles = (): string[] =>
  git(["ls-files", "--cached", "--others", "--exclude-standard"]);

/** Files a branch changes against `base`: committed (`base...HEAD`), staged, unstaged, untracked. */
export const changedFiles = (base: string): string[] => [
  ...new Set([
    ...git(["diff", "--name-only", "--no-renames", `${base}...HEAD`]),
    ...git(["diff", "--name-only", "--no-renames", "HEAD"]),
    ...git(["ls-files", "--others", "--exclude-standard"]),
  ]),
];
