/** Default host and VTC directories, resolved the way the cli and the hosts resolve them. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath, { basename, dirname, join, resolve, type PlatformPath } from "node:path";
import { ROLE_DENIED_VTC } from "@vtc/shared";

/** `$<name>` when set and non-empty, else `<home>/<fallback>`. A path only: nothing is read. */
export const envHome = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? join(homedir(), fallback) : value;
};

/** `scanners/**` → `<vtcHome>/scanners`, `token` → `<vtcHome>/token`, absolute on `path`'s platform. */
const vtcHomePaths = (vtcHome: string, globs: readonly string[], path: PlatformPath): string[] =>
  globs.map((glob) => path.resolve(vtcHome, glob.replace(/\/\*\*$/u, "")));

/**
 * D-w, D-ap (spine §5 reading 73): what no role may write under the VTC home, from
 * `ROLE_DENIED_VTC.homeWriteDeny`, as absolute paths of the given platform. An entry is a
 * directory (`scanners/**` → `<vtcHome>/scanners`, everything below it) or a single file
 * (`config.yaml`, `token`). Claude's `sandbox.filesystem.denyWrite` takes either form, and the
 * Codex profile's overlap check compares either against the worktree.
 */
export const vtcHomeWriteDeniedPaths = (vtcHome: string, path: PlatformPath = nodePath): string[] =>
  vtcHomePaths(vtcHome, ROLE_DENIED_VTC.homeWriteDeny, path);

/**
 * D-an (spine §5 reading 71): what no role may read under the VTC home, from
 * `ROLE_DENIED_VTC.homeReadDeny` (the install token, the daemons' sockets, the hidden acceptance
 * tests), as absolute paths of the given platform. The one source for every read deny under the
 * VTC home, so the profiles and the Lead session's sandbox settings never drift apart.
 */
export const vtcHomeReadDeniedPaths = (vtcHome: string, path: PlatformPath = nodePath): string[] =>
  vtcHomePaths(vtcHome, ROLE_DENIED_VTC.homeReadDeny, path);

/**
 * The absolute path with every symlink in its longest existing prefix resolved (the part that
 * does not exist yet is kept as given), so two paths compare by where they really are. It only
 * resolves links: no file is opened or read.
 */
export const canonicalPath = (path: string): string => {
  const missing: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing);
    } catch {
      const parent = dirname(current);
      if (parent === current) return resolve(path);
      missing.unshift(basename(current));
      current = parent;
    }
  }
};
