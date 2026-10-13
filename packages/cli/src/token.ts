/**
 * The per-install token (AD-5 rule 2; owner: cli+binary team). `~/.vtc/token` holds 256 random
 * bits as base64url, mode 0600. The cli is its only reader and writer: `vtc install` and
 * `vtc engine --daemon` call {@link ensureInstallToken} (the daemon receives the value in
 * `EngineDeps.installToken`); the statusline shim and `vtc dashboard` call {@link readInstallToken}.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ENGINE_INSTANCE } from "@vtc/shared";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;

export const installTokenPath = (vtcHome: string): string =>
  join(vtcHome, ENGINE_INSTANCE.tokenFile);

/**
 * Reads the token. Throws when it is missing, malformed, or readable by group or others (on
 * POSIX): a token another user could read authenticates nothing.
 */
export const readInstallToken = (vtcHome: string): string => {
  const path = installTokenPath(vtcHome);
  if (process.platform !== "win32" && (statSync(path).mode & 0o077) !== 0) {
    throw new Error(`${path} is readable by other users; remove it and run vtc install`);
  }
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN.test(token)) throw new Error(`${path} does not hold a vtc install token`);
  return token;
};

/**
 * Creates the token once, race-free, then reads it. The complete file is written under a unique
 * temporary name and hard-linked into place, which fails if the token exists: concurrent callers
 * never see a partial file, and exactly one token wins.
 */
export const ensureInstallToken = (vtcHome: string): string => {
  mkdirSync(vtcHome, { recursive: true, mode: 0o700 });
  const path = installTokenPath(vtcHome);
  const temp = `${path}.${String(process.pid)}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, `${randomBytes(32).toString("base64url")}\n`, { flag: "wx", mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    unlinkSync(temp);
  }
  return readInstallToken(vtcHome);
};
