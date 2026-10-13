/** Default host and VTC directories, resolved the way the cli and the hosts resolve them. */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import nodePath, { basename, dirname, join, resolve, type PlatformPath } from "node:path";
import { ENGINE_INSTANCE, HIDDEN_TESTS, ROLE_DENIED_VTC } from "@vtc/shared";

/** `$<name>` when set and non-empty, else `<home>/<fallback>`. A path only: nothing is read. */
export const envHome = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? join(homedir(), fallback) : value;
};

/**
 * D-w: the VTC home's directories no role may write, from `ROLE_DENIED_VTC.homeWriteDeny`
 * (`allowlists/**` → `<vtcHome>/allowlists`), as absolute paths of the given platform.
 */
export const vtcHomeWriteDeniedDirs = (vtcHome: string, path: PlatformPath = nodePath): string[] =>
  ROLE_DENIED_VTC.homeWriteDeny.map((glob) => path.resolve(vtcHome, glob.replace(/\/\*\*$/u, "")));

/**
 * Directories under the VTC home no role may read, besides the install token: the hidden
 * acceptance tests (`HIDDEN_TESTS.homeDir`, §7.3 anti-gaming: they stay out of the Engineer's
 * sight until gate time) and the daemons' socket directory (`ENGINE_INSTANCE.socketDir`: a role
 * that could connect there could declare itself the cli). Relative to the VTC home.
 */
export const VTC_HOME_READ_DENIED_DIRS = [HIDDEN_TESTS.homeDir, ENGINE_INSTANCE.socketDir] as const;

/** {@link VTC_HOME_READ_DENIED_DIRS} as absolute paths of the given platform. */
export const vtcHomeReadDeniedDirs = (vtcHome: string, path: PlatformPath = nodePath): string[] =>
  VTC_HOME_READ_DENIED_DIRS.map((dir) => path.resolve(vtcHome, dir));

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
