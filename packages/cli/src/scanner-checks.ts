/**
 * `vtc doctor` and the pinned scanners (§4.4: "downloaded on demand by `vtc doctor`, into
 * `~/.vtc/`, pinned by checksum"; spine §5 reading 66). The store is the Gate Runner's typed
 * `gates.createScannerStore` (AD-13 rule 2: `gates/` owns the pinned scanner store): it downloads
 * over https, checks the pinned SHA-256 before anything is unpacked and re-verifies an install
 * before every use. Doctor only drives it: a plain `vtc doctor` reports each scanner without
 * downloading anything (the store is opened with a download that refuses), and
 * `vtc doctor --download` fetches the missing ones and refreshes the osv-scanner offline database
 * (`gates.downloadOsvDatabase`, into `~/.vtc/osv-db/`). A checksum mismatch installs nothing and
 * fails the check. Nothing downloaded is executed here, except the pinned, verified osv-scanner
 * fetching its own database on that explicit request.
 *
 * Where a scanner has no native build (Checkov on darwin-arm64, D-u, reading 41) it is
 * user-installed: doctor reports one on PATH and otherwise warns, and nothing more; the L4 IaC
 * gate is then skipped with a visible reason.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gates } from "@vtc/engine";
import type { DoctorCheck } from "./doctor-checks.js";

type ScannerStore = gates.ScannerStore;
type OpenScannerStore = (options: gates.ScannerStoreOptions) => ScannerStore;

export interface ScannerEnv {
  readonly vtcHome: string;
  /** The Gate Runner's store; `gates.createScannerStore` unless a test injects one. */
  readonly open?: OpenScannerStore;
  /** A user-installed scanner's version line (`<name> --version` on PATH), or `null`. */
  readonly onPath?: (name: string) => Promise<string | null>;
}

class NotDownloaded extends Error {
  constructor() {
    super("not downloaded");
    this.name = "NotDownloaded";
  }
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The store has no pinned build of the scanner for this machine. TODO(gate-runner): switch to a
 * typed discriminator (a `ScannerError` code, or a store query) once `gates/` exports one; until
 * then doctor-scanners.test.ts runs this against the real store, so a reworded message fails there.
 */
const noPinnedBuild = (error: unknown): boolean =>
  error instanceof gates.ScannerError && /no pinned build/.test(error.message);

/** A scanner with no pinned build here: one the user installed on PATH, or a warning. */
const userInstalled = async (env: ScannerEnv, name: string, why: string): Promise<DoctorCheck> => {
  const version = env.onPath === undefined ? null : await env.onPath(name).catch(() => null);
  if (version !== null)
    return { name, status: "ok", detail: `user-installed (${version}); no pinned build here` };
  const gate = name === "checkov" ? "the L4 IaC gate" : "its L4 gate";
  return {
    name,
    status: "warn",
    detail: `${why}. It is not on PATH either, so ${gate} is skipped with a visible reason`,
  };
};

/**
 * One check per pinned scanner. `check` never downloads: a missing scanner is a warning (the
 * first gate run that needs it fetches it too). `download` fetches each missing scanner, one at
 * a time, and fails the ones that do not verify. A scanner with no build for this platform is a
 * warning either way, or ok when the user installed it on PATH.
 */
export const checkScanners = async (
  env: ScannerEnv,
  mode: "check" | "download",
  progress: (line: string) => void,
): Promise<DoctorCheck[]> => {
  const open = env.open ?? gates.createScannerStore;
  const probe = open({
    vtcHome: env.vtcHome,
    download: () => Promise.reject(new NotDownloaded()),
  });
  const checks: DoctorCheck[] = [];
  const missing: number[] = [];
  for (const name of probe.names) {
    try {
      const path = await probe.ensure(name);
      checks.push({ name, status: "ok", detail: `verified (${path})` });
    } catch (error) {
      if (error instanceof NotDownloaded) {
        missing.push(checks.length);
        checks.push({
          name,
          status: "warn",
          detail:
            "not downloaded yet, or its install no longer verifies: run vtc doctor --download (a gate run that needs it fetches it too)",
        });
      } else if (noPinnedBuild(error)) checks.push(await userInstalled(env, name, message(error)));
      else checks.push({ name, status: "warn", detail: message(error) });
    }
  }
  if (mode === "check" || missing.length === 0) return checks;
  const store = open({ vtcHome: env.vtcHome });
  for (const index of missing) {
    const name = checks[index]?.name ?? "";
    progress(`Downloading ${name} (pinned by SHA-256) into ${env.vtcHome}...`);
    try {
      const path = await store.ensure(name);
      checks[index] = { name, status: "ok", detail: `downloaded and verified (${path})` };
    } catch (error) {
      checks[index] = { name, status: "fail", detail: message(error) };
    }
  }
  return checks;
};

// ------------------------------------------------------------- osv offline database

/** What the osv-scanner database check reads and runs. */
export interface OsvEnv {
  /** When the database under `~/.vtc/osv-db/` was downloaded, or `null` when it is not there. */
  readonly fetchedAt: (vtcHome: string) => string | null;
  /** The repo doctor runs in: its lockfiles name the ecosystems to download. */
  readonly checkout: () => Promise<string | null>;
  readonly download: (request: {
    readonly vtcHome: string;
    readonly scanners: ScannerStore;
    readonly checkoutAbs: string;
  }) => Promise<{ readonly ok: boolean; readonly detail: string }>;
}

/** The download time in the database's stamp, when `gates.osvDatabaseReady`. */
export const osvFetchedAt = (vtcHome: string): string | null => {
  if (!gates.osvDatabaseReady(vtcHome)) return null;
  try {
    const stamp = JSON.parse(
      readFileSync(join(gates.osvDatabaseDir(vtcHome), gates.OSV_DB_STAMP), "utf8"),
    ) as { fetched_at?: unknown };
    return typeof stamp.fetched_at === "string" ? stamp.fetched_at : "at an unknown time";
  } catch {
    return null;
  }
};

/** The real download: the pinned osv-scanner, its logs under `~/.vtc/logs/osv-db/`. */
export const downloadOsvDatabase: OsvEnv["download"] = (request) =>
  gates.downloadOsvDatabase({
    vtcHome: request.vtcHome,
    scanners: request.scanners,
    checkoutAbs: request.checkoutAbs,
    logDir: join(request.vtcHome, "logs", "osv-db"),
    env: process.env,
    now: new Date(),
  });

/**
 * The osv-scanner offline database (§7.2 L4 `osv-scanner --offline`): gates never reach the
 * network, so without it the dependency gate reports `infra`. A plain doctor reports it;
 * `--download` refreshes it (only on that explicit request, like the scanners themselves).
 */
export const checkOsvDatabase = async (
  env: OsvEnv,
  vtcHome: string,
  scanners: ScannerStore,
  mode: "check" | "download",
): Promise<DoctorCheck> => {
  const name = "osv-db";
  if (mode === "check") {
    const at = env.fetchedAt(vtcHome);
    return at === null
      ? {
          name,
          status: "warn",
          detail:
            "not downloaded: run vtc doctor --download in a repo (the dependency gate reports infra without it)",
        }
      : { name, status: "ok", detail: `downloaded ${at} (${gates.osvDatabaseDir(vtcHome)})` };
  }
  const checkoutAbs = await env.checkout();
  if (checkoutAbs === null)
    return {
      name,
      status: "warn",
      detail: "run vtc doctor --download inside a repo: the database follows that repo's lockfiles",
    };
  const result = await env.download({ vtcHome, scanners, checkoutAbs });
  return { name, status: result.ok ? "ok" : "fail", detail: result.detail };
};
