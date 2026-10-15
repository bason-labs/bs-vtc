/**
 * What the opt-in live checks share (`dcl-check.ts`, `h15-check.ts`; D-cl's rules, spine §5
 * readings 206 and 239): writing results, temp directories, the redaction context, and the refusal
 * to run a command that carries a bypass, a disallowed flag or an isolation gap (AD-9, AD-25).
 */
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  findDisallowedHostArgs,
  findForbiddenHostArgs,
  headlessIsolationGaps,
  type HostCommand,
} from "@vtc/shared";
import type { RecordingContext } from "./recording.js";

export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");

export const write = (dir: string, name: string, text: string): void => {
  writeFileSync(join(dir, name), text, "utf8");
  console.warn(`wrote ${join(dir, name)}`);
};

export const jsonl = (lines: readonly string[]): string =>
  lines.map((line) => `${line}\n`).join("");

const refuse = (command: HostCommand, gaps: readonly string[]): void => {
  const refused = [
    ...findForbiddenHostArgs([command.command, ...command.args]),
    ...findDisallowedHostArgs(command.args),
    ...gaps.map((gap) => `missing ${gap}`),
  ];
  if (refused.length > 0) throw new Error(`refusing to run: ${refused.join(", ")}`);
  console.warn(`$ ${command.command} ${command.args.map((a) => JSON.stringify(a)).join(" ")}`);
};

/** Throws before anything runs when a role run's `command` has a bypass, a disallowed flag or a gap. */
export const refuseUnsafe = (host: "claude-code" | "codex", command: HostCommand): void => {
  refuse(command, headlessIsolationGaps(host, command.args));
};

/**
 * Throws before anything runs when `command` has a bypass or a disallowed flag: for a probe that
 * is not a role run and loads other settings on purpose (the H-15 Claude checks).
 */
export const refuseBypass = (command: HostCommand): void => {
  refuse(command, []);
};

export const tempDir = (prefix: string): string =>
  realpathSync(mkdtempSync(join(tmpdir(), prefix)));

export const context = (paths: readonly string[]): RecordingContext => ({
  home: homedir(),
  cwd: paths,
  user: userInfo().username,
});

/** `path` with its nearest existing ancestor's symlinks resolved (the rest may not exist yet). */
const realpathOfNearest = (path: string): string => {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync(current), ...missing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.push(basename(current));
      current = parent;
    }
  }
};

/**
 * `--out` must be outside the repo: raw files can name the owner's own setup. Compared after
 * resolving symlinks (an `--out` linked into the repo is inside it), and only `..` itself or a
 * path starting with `../` is outside (a directory named `..out` in the repo is inside). Returns
 * the resolved path.
 */
export const outsideRepo = (out: string, repoRoot: string = REPO_ROOT): string => {
  const real = realpathOfNearest(out);
  const rel = relative(realpathOfNearest(repoRoot), real);
  if (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
    throw new Error("--out must be outside the repo: raw files can name the owner's own setup");
  }
  return real;
};
