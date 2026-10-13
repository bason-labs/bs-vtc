/**
 * `vtc doctor` and the pinned scanners (§4.4: "downloaded on demand by `vtc doctor`, into
 * `~/.vtc/`, pinned by checksum"). The store is the Gate Runner's (AD-13 rule 2: `gates/` owns
 * the pinned scanner store): it downloads over https, checks the pinned SHA-256 before anything
 * is unpacked and re-verifies an install before every use. Doctor only drives it: a plain
 * `vtc doctor` reports each scanner without downloading anything (the store is opened with a
 * download that refuses), and `vtc doctor --download` fetches the missing ones. A checksum
 * mismatch installs nothing and fails the check. Downloads are never executed here.
 */
import type { DoctorCheck } from "./doctor-checks.js";

/** The subset of the Gate Runner's `ScannerStoreOptions` doctor passes. */
export interface ScannerStoreOptions {
  readonly vtcHome: string;
  /** Replaces the store's https download; doctor's probe passes one that refuses. */
  readonly download?: (url: string) => Promise<Uint8Array>;
}

/** The Gate Runner's `ScannerStore`: pinned names, and `ensure` (verified path, else download). */
export interface ScannerStoreLike {
  readonly names: readonly string[];
  ensure(name: string): Promise<string>;
}

export type OpenScannerStore = (options: ScannerStoreOptions) => ScannerStoreLike;

/**
 * The engine's `gates.createScannerStore`, or `null` in a build whose Gate Runner has no store
 * yet. Looked up by name so this cli builds against an engine with or without it.
 */
export const engineScannerStore = (gatesApi: object): OpenScannerStore | null => {
  const create = (gatesApi as { readonly createScannerStore?: unknown }).createScannerStore;
  return typeof create === "function" ? (options) => (create as OpenScannerStore)(options) : null;
};

export interface ScannerEnv {
  readonly open: OpenScannerStore | null;
  readonly vtcHome: string;
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
 * One check per pinned scanner. `check` never downloads: a missing scanner is a warning (the
 * first gate run that needs it fetches it too). `download` fetches each missing scanner, one at
 * a time, and fails the ones that do not verify. A scanner with no build for this platform is a
 * warning either way.
 */
export const checkScanners = async (
  env: ScannerEnv,
  mode: "check" | "download",
  progress: (line: string) => void,
): Promise<DoctorCheck[]> => {
  if (env.open === null)
    return [
      {
        name: "scanners",
        status: mode === "download" ? "fail" : "warn",
        detail:
          "this build of vtc has no pinned scanner store yet: L4 scanners must be installed by hand and confirmed in vtc calibrate",
      },
    ];
  const probe = env.open({
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
      } else checks.push({ name, status: "warn", detail: message(error) });
    }
  }
  if (mode === "check" || missing.length === 0) return checks;
  const store = env.open({ vtcHome: env.vtcHome });
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
