/**
 * The osv-scanner offline vulnerability database (§7.2 L4 `osv-scanner --offline`, §15:
 * "vulnerability databases update on an explicit schedule"). Gates never reach the network, so
 * the database is downloaded only when a human asks for it in `vtc calibrate`, into
 * `~/.vtc/osv-db/`, with the download time recorded next to it. Without it the dependency gate
 * does not start: it reports `error` / `infra` instead of passing with no advisories loaded.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gateEnv, runCommand, type ExecResult } from "./exec.js";
import type { ScannerStore } from "./scanners.js";

export const OSV_DB_DIR = "osv-db";
/** Written after a successful download: `{ "fetched_at": "<ISO time>" }`. */
export const OSV_DB_STAMP = "vtc-fetched.json";
/** The variable osv-scanner reads the offline database location from. */
export const OSV_DB_ENV = "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY";

export const osvDatabaseDir = (vtcHome: string): string => join(vtcHome, OSV_DB_DIR);

/** True once a download completed (the stamp exists and something else is in the directory). */
export const osvDatabaseReady = (vtcHome: string): boolean => {
  const dir = osvDatabaseDir(vtcHome);
  try {
    const names = readdirSync(dir);
    return names.includes(OSV_DB_STAMP) && names.some((n) => n !== OSV_DB_STAMP);
  } catch {
    return false;
  }
};

export interface OsvDownloadRequest {
  readonly vtcHome: string;
  readonly scanners: ScannerStore;
  /** Absolute checkout whose lockfiles name the ecosystems to download. */
  readonly checkoutAbs: string;
  /** Absolute directory for the raw logs and the throw-away report. */
  readonly logDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly timeoutMs?: number;
}

/**
 * Downloads the databases for the checkout's ecosystems with the pinned osv-scanner. This is the
 * only osv-scanner call with network access, and only `vtc calibrate` makes it, after a human
 * said yes.
 */
export const downloadOsvDatabase = async (
  request: OsvDownloadRequest,
): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  let binary: string;
  try {
    binary = await request.scanners.ensure("osv-scanner");
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const dir = osvDatabaseDir(request.vtcHome);
  const exec: ExecResult = await runCommand({
    argv: [
      binary,
      "scan",
      "source",
      "--offline-vulnerabilities",
      "--download-offline-databases",
      "--format",
      "json",
      "--output",
      join(request.logDir, "osv-download.json"),
      "-r",
      ".",
    ],
    cwd: request.checkoutAbs,
    env: gateEnv(request.env, { [OSV_DB_ENV]: dir }),
    timeoutMs: request.timeoutMs ?? 15 * 60 * 1000,
    stdoutPath: join(request.logDir, "osv-download.stdout.log"),
    stderrPath: join(request.logDir, "osv-download.stderr.log"),
  });
  // osv-scanner exits 1 when it found vulnerabilities: the download itself still succeeded.
  const downloaded =
    exec.spawnError === undefined &&
    !exec.timedOut &&
    (exec.code === 0 || exec.code === 1) &&
    existsSync(dir) &&
    readdirSync(dir).length > 0;
  if (!downloaded) {
    const why = exec.timedOut ? "timed out" : (exec.spawnError ?? `exit code ${String(exec.code)}`);
    return { ok: false, detail: `the download failed (${why}); see ${request.logDir}` };
  }
  writeFileSync(
    join(dir, OSV_DB_STAMP),
    `${JSON.stringify({ fetched_at: request.now.toISOString() }, null, 2)}\n`,
  );
  return { ok: true, detail: `downloaded into ${dir}` };
};
