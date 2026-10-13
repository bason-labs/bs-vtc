/** Disk I/O around the pure compile step: read the sources, write `dist/<target>`. */
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { COMPILE_TARGETS } from "./checks.js";
import type { CompileError, CompileOutput, SourceFile } from "./types.js";

/** Directories the compiler reads, relative to the product repo root. */
export const SOURCE_DIRS = ["roles", "skills", "plugins"] as const;

const LITTER = new Set([".DS_Store", "Thumbs.db"]);

export interface SourceRead {
  /** Every regular UTF-8 file, sorted by POSIX path. */
  readonly files: readonly SourceFile[];
  /** Symbolic links, non-UTF-8 files and other entries that are not regular files. */
  readonly errors: readonly CompileError[];
}

const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Never follows a symbolic link: a link could pull a file from outside the repo (a credential,
 * say) into the plugin, or loop. Sources are text, so a file that is not UTF-8 is an error rather
 * than silently re-encoded.
 */
const walk = (root: string, rel: string, out: SourceFile[], errors: CompileError[]): void => {
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (LITTER.has(name)) continue;
    const path = `${rel}/${name}`;
    const stat = lstatSync(join(root, path));
    if (stat.isSymbolicLink()) {
      errors.push({ path, message: "symbolic links are not compiled; commit the file itself" });
    } else if (stat.isDirectory()) {
      walk(root, path, out, errors);
    } else if (!stat.isFile()) {
      errors.push({ path, message: "not a regular file" });
    } else {
      try {
        out.push({ path, text: decoder.decode(readFileSync(join(root, path))) });
      } catch {
        errors.push({ path, message: "not UTF-8 text; sources are text files" });
      }
    }
  }
};

/** Every file under `roles/`, `skills/` and `plugins/`, sorted by POSIX path. */
export const readSources = (root: string): SourceRead => {
  const files: SourceFile[] = [];
  const errors: CompileError[] = [];
  for (const dir of SOURCE_DIRS) {
    let stat;
    try {
      stat = lstatSync(join(root, dir));
    } catch {
      continue; // a missing source directory compiles as empty; the compile step reports what is required
    }
    if (stat.isDirectory()) walk(root, dir, files, errors);
    else
      errors.push({ path: dir, message: "must be a directory (symbolic links are not followed)" });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, errors };
};

/**
 * Replaces `dist/claude-plugin` and `dist/codex-plugin` under `root` with the compiled trees.
 * Throws before writing anything when a file path would land outside its target directory.
 * Returns the written paths relative to `root`.
 */
export const writeTargets = (output: CompileOutput, root: string): string[] => {
  const targets = Object.entries(COMPILE_TARGETS) as [keyof typeof COMPILE_TARGETS, string][];
  for (const [host, dir] of targets) {
    const base = resolve(root, dir);
    for (const file of output.targets[host]) {
      const inside = relative(base, resolve(base, file.path));
      if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(`refusing to write ${host}:${file.path} outside ${dir}`);
      }
    }
  }
  const written: string[] = [];
  for (const [host, dir] of targets) {
    rmSync(join(root, dir), { recursive: true, force: true });
    for (const file of output.targets[host]) {
      const target = join(root, dir, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.text);
      written.push(`${dir}/${file.path}`);
    }
  }
  return written;
};
