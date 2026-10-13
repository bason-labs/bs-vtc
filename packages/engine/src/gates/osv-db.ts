/**
 * The osv-scanner offline vulnerability database (§7.2 L4 `osv-scanner --offline`, §15:
 * "vulnerability databases update on an explicit schedule"). Gates never reach the network, so
 * the database is downloaded only when a human asks for it in `vtc calibrate`, into
 * `~/.vtc/osv-db/`, with the download time recorded next to it. Without it the dependency gate
 * does not start: it reports `error` / `infra` instead of passing with no advisories loaded.
 *
 * The download runs in the gate sandbox's install phase (D-al): network, but writes only to the
 * checkout and the run's private directories. It lands there first and is copied into the VTC
 * home after the scanner exits.
 */
import { cpSync, existsSync, lstatSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GATE_SANDBOX, type GateSandbox } from "@vtc/shared";
import { gateEnv, type ExecResult } from "./exec.js";
import { GateCommandJail, gateReadPolicy, resolveGateSandbox } from "./sandbox.js";
import type { ScannerStore } from "./scanners.js";

export const OSV_DB_DIR = "osv-db";
/** Written after a successful download: `{ "fetched_at": "<ISO time>" }`. */
export const OSV_DB_STAMP = "vtc-fetched.json";
/** The variable osv-scanner reads the offline database location from. */
export const OSV_DB_ENV = "OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY";

export const osvDatabaseDir = (vtcHome: string): string => join(vtcHome, OSV_DB_DIR);

const isSymlink = (path: string): boolean => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return true;
  }
};

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
  /** Absolute directory for the raw logs. */
  readonly logDir: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly now: Date;
  readonly timeoutMs?: number;
  /** The gate sandbox the download runs in (D-al); absent: the machine's own. */
  readonly sandbox?: GateSandbox;
  /** `gates.allow_unsandboxed` from the user config: with no sandbox, download unconfined. */
  readonly allowUnsandboxed?: boolean;
}

/**
 * Downloads the databases for the checkout's ecosystems with the pinned osv-scanner. This is the
 * only osv-scanner call with network access, and only `vtc calibrate` or `vtc doctor --download`
 * makes it, after a human asked. It runs in the gate sandbox's install phase: the database lands
 * in the run's private `HOME` and is copied into the VTC home once the scanner has exited.
 */
export const downloadOsvDatabase = async (
  request: OsvDownloadRequest,
): Promise<{ readonly ok: boolean; readonly detail: string }> => {
  const sandbox = resolveGateSandbox(request);
  if (sandbox === null) {
    return {
      ok: false,
      detail: `${GATE_SANDBOX.noSandboxReason}: the download did not start (vtc doctor says why; gates.allow_unsandboxed in ~/.vtc/config.yaml runs it unconfined)`,
    };
  }
  let binary: string;
  try {
    binary = await request.scanners.ensure("osv-scanner");
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
  const dir = osvDatabaseDir(request.vtcHome);
  const policy = gateReadPolicy({ vtcHome: request.vtcHome, env: request.env });
  const jail = new GateCommandJail(sandbox, policy.denyRead, policy);
  try {
    const staging = join(jail.homeDir(), "osv-db");
    const exec: ExecResult = await jail.run({
      phase: "install",
      checkout: request.checkoutAbs,
      argv: [
        binary,
        "scan",
        "source",
        "--offline-vulnerabilities",
        "--download-offline-databases",
        "--format",
        "json",
        "--output",
        join(jail.homeDir(), "osv-download.json"),
        "-r",
        ".",
      ],
      cwd: request.checkoutAbs,
      env: gateEnv(request.env, { [OSV_DB_ENV]: staging }),
      timeoutMs: request.timeoutMs ?? 15 * 60 * 1000,
      stdoutPath: join(request.logDir, "osv-download.stdout.log"),
      stderrPath: join(request.logDir, "osv-download.stderr.log"),
    });
    // osv-scanner exits 1 when it found vulnerabilities: the download itself still succeeded.
    const downloaded =
      exec.spawnError === undefined &&
      !exec.timedOut &&
      (exec.code === 0 || exec.code === 1) &&
      existsSync(staging) &&
      readdirSync(staging).length > 0;
    if (!downloaded) {
      const why = exec.timedOut
        ? "timed out"
        : (exec.spawnError ?? `exit code ${String(exec.code)}`);
      return { ok: false, detail: `the download failed (${why}); see ${request.logDir}` };
    }
    rmSync(dir, { recursive: true, force: true });
    // Regular files and directories only: no symlink the download left reaches the VTC home.
    cpSync(staging, dir, { recursive: true, filter: (src) => !isSymlink(src) });
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    jail.dispose();
  }
  writeFileSync(
    join(dir, OSV_DB_STAMP),
    `${JSON.stringify({ fetched_at: request.now.toISOString() }, null, 2)}\n`,
  );
  return { ok: true, detail: `downloaded into ${dir}` };
};
