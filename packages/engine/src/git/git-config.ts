/**
 * The repository's own git configuration as an agent could change it (AD-7 rule 7, AD-8 rule 3).
 * `git status` never shows `.git/`, yet a write there changes what the engine's own git calls do:
 * a hook, `commit.gpgsign` with `gpg.program`, a `filter.<x>.clean` or `merge.<x>.driver` named
 * from `.git/info/attributes`, or an exclude that hides a file from the write check. The engine
 * fingerprints these files while a role works in the user's checkout and refuses to run git on a
 * changed set (see `phase-scope.ts`). Synchronous: it runs before every engine commit.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, resolve } from "node:path";

/** The git configuration changed while a role worked in the checkout. */
export class GitConfigChangedError extends Error {
  constructor(readonly paths: readonly string[]) {
    super(
      `refusing to run git: ${paths.join(", ")} changed while a role worked in the checkout`.slice(
        0,
        500,
      ),
    );
    this.name = "GitConfigChangedError";
  }
}

/** The repo's common git dir, found without running git; `null` when there is none. */
export const gitDirOf = (repoRoot: string): string | null => {
  const dotGit = join(repoRoot, ".git");
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) return dotGit;
    if (!stat.isFile()) return null;
    const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
    const pointer = match?.[1]?.trim();
    if (pointer === undefined || pointer === "") return null;
    const dir = resolve(repoRoot, pointer);
    const common = join(dir, "commondir");
    return existsSync(common) ? resolve(dir, readFileSync(common, "utf8").trim()) : dir;
  } catch {
    return null;
  }
};

const fingerprintOf = (abs: string): string | undefined => {
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(abs)}`;
    if (stat.isDirectory()) return undefined;
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return undefined;
  }
};

const namesIn = (dir: string): string[] => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

const filesUnder = (dir: string, depth: number): string[] => {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const abs = join(dir, name);
    try {
      const stat = lstatSync(abs);
      if (stat.isDirectory() && !stat.isSymbolicLink())
        return depth > 0 ? filesUnder(abs, depth - 1).map((f) => `${name}/${f}`) : [];
    } catch {
      return [];
    }
    return [name];
  });
};

/**
 * Content hashes of the git files that change what git runs or sees, keyed `.git/<path>`:
 * `config`, `config.worktree`, `info/attributes`, `info/exclude`, every hook, and each linked
 * worktree's `config.worktree`. A missing file has no key.
 */
export const gitConfigFingerprint = (repoRoot: string): Record<string, string> => {
  const dir = gitDirOf(repoRoot);
  if (dir === null) return {};
  const rels = [
    "config",
    "config.worktree",
    "info/attributes",
    "info/exclude",
    ...filesUnder(join(dir, "hooks"), 2).map((f) => `hooks/${f}`),
    ...namesIn(join(dir, "worktrees")).map((name) => `worktrees/${name}/config.worktree`),
  ];
  const out: Record<string, string> = {};
  for (const rel of rels.sort()) {
    const hash = fingerprintOf(join(dir, rel));
    if (hash !== undefined) out[`.git/${rel}`] = hash;
  }
  return out;
};

/** Keys whose hash differs between two fingerprints (added, removed or changed). */
export const fingerprintChanges = (
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): string[] =>
  [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter((k) => before[k] !== after[k])
    .sort();
