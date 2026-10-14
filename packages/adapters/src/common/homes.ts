/** Default host and VTC directories, resolved the way the cli and the hosts resolve them. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath, { basename, dirname, join, relative, resolve, type PlatformPath } from "node:path";
import { ROLE_DENIED_VTC, WAVE3_HOME_WRITE_DENY } from "@vtc/shared";

/** `$<name>` when set and non-empty, else `<home>/<fallback>`. A path only: nothing is read. */
export const envHome = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? join(homedir(), fallback) : value;
};

/**
 * Globs relative to the VTC home that no role may write: `ROLE_DENIED_VTC.homeWriteDeny` plus the
 * wave-3 directories (`WAVE3_HOME_WRITE_DENY`, contracts 4.5.0: Lookback versions and pins, the
 * research cache, the pinned browser store, the design library; spine §5 reading 103). The
 * integrator folds the wave-3 list into `homeWriteDeny` at the wave-3 merge, so each glob is kept
 * once and the lists stay right before and after that merge.
 */
export const ROLE_HOME_WRITE_DENY: readonly string[] = [
  ...new Set<string>([...ROLE_DENIED_VTC.homeWriteDeny, ...WAVE3_HOME_WRITE_DENY]),
];

/** `scanners/**` → `<vtcHome>/scanners`, `token` → `<vtcHome>/token`, absolute on `path`'s platform. */
const vtcHomePaths = (vtcHome: string, globs: readonly string[], path: PlatformPath): string[] =>
  globs.map((glob) => path.resolve(vtcHome, glob.replace(/\/\*\*$/u, "")));

/**
 * D-w, D-ap (spine §5 reading 73): what no role may write under the VTC home, from
 * {@link ROLE_HOME_WRITE_DENY}, as absolute paths of the given platform. An entry is a
 * directory (`scanners/**` → `<vtcHome>/scanners`, everything below it) or a single file
 * (`config.yaml`, `token`). Claude's `sandbox.filesystem.denyWrite` takes either form, and the
 * Codex profile's overlap check compares either against the worktree.
 */
export const vtcHomeWriteDeniedPaths = (vtcHome: string, path: PlatformPath = nodePath): string[] =>
  vtcHomePaths(vtcHome, ROLE_HOME_WRITE_DENY, path);

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

/** True when `inner` is `outer` or below it (both already canonical). */
export const within = (outer: string, inner: string): boolean => {
  const rel = relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/") && !/^[A-Za-z]:/.test(rel));
};
