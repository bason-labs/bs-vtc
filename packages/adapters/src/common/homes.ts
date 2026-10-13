/** Default host and VTC directories, resolved the way the cli and the hosts resolve them. */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ROLE_DENIED_VTC } from "@vtc/shared";

/** `$<name>` when set and non-empty, else `<home>/<fallback>`. A path only: nothing is read. */
export const envHome = (name: string, fallback: string): string => {
  const value = process.env[name];
  return value === undefined || value === "" ? join(homedir(), fallback) : value;
};

/**
 * D-w: the VTC home's directories no role may write, from `ROLE_DENIED_VTC.homeWriteDeny`
 * (`allowlists/**` → `<vtcHome>/allowlists`), as absolute paths.
 */
export const vtcHomeWriteDeniedDirs = (vtcHome: string): string[] =>
  ROLE_DENIED_VTC.homeWriteDeny.map((glob) => resolve(vtcHome, glob.replace(/\/\*\*$/u, "")));
