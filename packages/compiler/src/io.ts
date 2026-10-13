/** Disk I/O around the pure compile step: read the sources, write `dist/<target>`. */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { COMPILE_TARGETS } from "./checks.js";
import type { CompileOutput, SourceFile } from "./types.js";

/** Directories the compiler reads, relative to the product repo root. */
export const SOURCE_DIRS = ["roles", "skills", "plugins"] as const;

const LITTER = new Set([".DS_Store", "Thumbs.db"]);

const walk = (root: string, rel: string, out: SourceFile[]): void => {
  for (const name of readdirSync(join(root, rel))) {
    if (LITTER.has(name)) continue;
    const path = `${rel}/${name}`;
    if (statSync(join(root, path)).isDirectory()) walk(root, path, out);
    else out.push({ path, text: readFileSync(join(root, path), "utf8") });
  }
};

/** Every file under `roles/`, `skills/` and `plugins/`, sorted by POSIX path. */
export const readSources = (root: string): SourceFile[] => {
  const out: SourceFile[] = [];
  for (const dir of SOURCE_DIRS) {
    try {
      if (statSync(join(root, dir)).isDirectory()) walk(root, dir, out);
    } catch {
      // a missing source directory compiles as empty; the compile step reports what is required
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
};

/**
 * Replaces `dist/claude-plugin` and `dist/codex-plugin` under `root` with the compiled trees.
 * Returns the written paths relative to `root`.
 */
export const writeTargets = (output: CompileOutput, root: string): string[] => {
  const written: string[] = [];
  for (const [host, dir] of Object.entries(COMPILE_TARGETS) as [
    keyof typeof COMPILE_TARGETS,
    string,
  ][]) {
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
