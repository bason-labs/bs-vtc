/**
 * The pinned scanner store (§4.4, §7.2, §15): scanners are downloaded on demand into
 * `~/.vtc/scanners/<name>/<version>/<platform>/`, verified against the pinned SHA-256 before
 * anything is unpacked, and re-verified before every use against the pinned SHA-256 of the
 * extracted executable (`ScannerPin.binary_sha256`, D-ap, spine §5 reading 73), never against the
 * manifest stored beside it: whoever could write the store could rewrite both. A platform pinned
 * without a binary checksum has no anchor for an installed copy, so it is downloaded and verified
 * against the download pin again before each use. Nothing is auto-updated: a different version
 * only arrives with a new pin in a new vtc release.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative } from "node:path";
import type { Platform, ScannerPin, ScannerPins } from "@vtc/shared";
import { SCANNER_ASSETS, SCANNER_PINS, type ScannerAssets } from "./scanner-pins.js";

export class ScannerError extends Error {
  constructor(
    readonly scanner: string,
    detail: string,
  ) {
    super(`scanner ${scanner}: ${detail}`);
    this.name = "ScannerError";
  }
}

/**
 * A pinned scanner with no build for this machine's platform (no pin, or no platform VTC knows).
 * Where a scanner is user-installed on such a platform (Checkov on darwin-arm64, D-u, spine §5
 * reading 41), the Gate Runner looks for the user's own install instead and otherwise skips the
 * gate with a visible reason; `vtc doctor` warns.
 */
export class ScannerUnavailableError extends ScannerError {
  constructor(
    scanner: string,
    /** The platform without a build (`os-arch` as Node names it when VTC knows no target). */
    readonly platform: string,
  ) {
    super(
      scanner,
      USER_INSTALLED_SCANNERS.includes(scanner)
        ? `no pinned build for ${platform}; install it yourself: the Gate Runner then runs the first ${scanner} on an absolute PATH entry outside the repo, which VTC does not checksum-verify`
        : `no pinned build for ${platform}`,
    );
    this.name = "ScannerUnavailableError";
  }
}

/**
 * Scanners a user installs on a platform without a pinned build (D-u: Checkov has no darwin-arm64
 * build and VTC pins no Rosetta one). Elsewhere every pinned scanner comes only from the store.
 */
export const USER_INSTALLED_SCANNERS: readonly string[] = ["checkov"];

const isInsideDir = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

/**
 * A user-installed scanner on `PATH`: the first executable regular file named `name` in an
 * absolute `PATH` entry that is not inside any of `untrusted` (the repo and its checkouts, which
 * a diff controls), symlinks resolved. Relative entries are ignored for the same reason. `null`
 * when there is none. It is not SHA-verified and nothing records or confirms its path: whatever
 * the user's `PATH` resolves to at gate time runs, and the gate's evidence names it.
 */
export const findUserInstalled = (
  name: string,
  pathValue: string | undefined,
  untrusted: readonly string[],
  platform: string = process.platform,
): string | null => {
  const names = platform === "win32" ? [`${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name];
  const roots = untrusted.flatMap((root) => {
    try {
      return [realpathSync(root)];
    } catch {
      return [];
    }
  });
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    for (const file of names) {
      let real: string;
      try {
        real = realpathSync(join(dir, file));
        if (!statSync(real).isFile()) continue;
        accessSync(real, constants.X_OK);
      } catch {
        continue;
      }
      if (roots.some((root) => isInsideDir(root, real) || isInsideDir(root, join(dir, file))))
        continue;
      return real;
    }
  }
  return null;
};

/** Downloads bytes over https (following redirects). Injected in tests: they never download. */
export type Download = (url: string) => Promise<Uint8Array>;

/** Unpacks an archive into an empty directory. */
export type Extract = (archive: string, kind: "tar.gz" | "zip", into: string) => void;

export interface ScannerStoreOptions {
  /** Absolute VTC home: installs go to `<vtcHome>/scanners/<name>/<version>/<platform>/`. */
  readonly vtcHome: string;
  readonly platform?: Platform | null;
  readonly pins?: ScannerPins;
  readonly assets?: Readonly<Record<string, ScannerAssets>>;
  readonly download?: Download;
  readonly extract?: Extract;
}

export const SCANNERS_DIR = "scanners";
const MANIFEST = "vtc-scanner.json";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** This machine's download target, or `null` when no binary is published for it. */
export const currentPlatform = (
  platform: string = process.platform,
  arch: string = process.arch,
): Platform | null => {
  const os =
    platform === "darwin"
      ? "darwin"
      : platform === "linux"
        ? "linux"
        : platform === "win32"
          ? "windows"
          : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x64" : null;
  if (os === null || cpu === null) return null;
  const target = `${os}-${cpu}`;
  return target === "windows-arm64" ? null : (target as Platform);
};

export const defaultDownload: Download = async (url) => {
  if (!url.startsWith("https://")) throw new Error(`refusing a non-https download: ${url}`);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: HTTP ${String(response.status)} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
};

/** Unpacks with the system `tar` (bsdtar reads zip too; GNU tar does not, so zip uses `unzip` there). */
export const defaultExtract: Extract = (archive, kind, into) => {
  const useUnzip = kind === "zip" && process.platform === "linux";
  const [cmd, args] = useUnzip
    ? ["unzip", ["-q", archive, "-d", into]]
    : ["tar", [kind === "zip" ? "-xf" : "-xzf", archive, "-C", into]];
  const result = spawnSync(cmd, args, { stdio: "pipe", shell: false, timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(
      `could not unpack ${archive}: ${result.stderr.toString("utf8").trim() || String(result.error)}`,
    );
  }
};

const archiveKind = (asset: string): "raw" | "tar.gz" | "zip" =>
  asset.endsWith(".tar.gz") || asset.endsWith(".tgz")
    ? "tar.gz"
    : asset.endsWith(".zip")
      ? "zip"
      : "raw";

/** The download URL of a pin on a platform. */
export const scannerUrl = (pin: ScannerPin, asset: string): string =>
  pin.url.replaceAll("{version}", pin.version).replaceAll("{platform}", asset);

const findBinary = (dir: string, names: readonly string[]): string | null => {
  const queue = [dir];
  while (queue.length > 0) {
    const current = queue.shift() ?? dir;
    const entries = readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    );
    for (const entry of entries) {
      if (entry.isFile() && names.includes(entry.name)) return join(current, entry.name);
    }
    for (const entry of entries) if (entry.isDirectory()) queue.push(join(current, entry.name));
  }
  return null;
};

/** Written beside an install to locate its executable. Never trusted for verification (D-ap). */
interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly platform: Platform;
  readonly download_sha256: string;
  /** Path of the executable relative to the install directory. */
  readonly binary: string;
  /** Informational: verification compares with `ScannerPin.binary_sha256`, not this. */
  readonly binary_sha256: string;
}

const readManifest = (dir: string): Manifest | null => {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
  } catch {
    return null;
  }
};

/**
 * The pinned scanner store the cli opens for `vtc doctor` and the Gate Runner uses for L4
 * (AD-13 rule 2: `gates/` owns it).
 */
export interface ScannerStore {
  /** Names of the pinned scanners (allowed by name, `gateCommandAllowed`). */
  readonly names: readonly string[];
  /**
   * The verified executable of a pinned scanner. A verified install is used as it is; only a
   * missing or no longer verifying one is downloaded (through `options.download`) and checked
   * against the pinned SHA-256 before anything is unpacked. Rejects with
   * {@link ScannerUnavailableError} when there is no build for this platform, and with
   * {@link ScannerError} for an unknown name or a checksum mismatch.
   */
  ensure(name: string): Promise<string>;
}

/** `gates.createScannerStore`: the typed factory the cli wires (doctor, Gate Runner). */
export type CreateScannerStore = (options: ScannerStoreOptions) => ScannerStore;

export const createScannerStore: CreateScannerStore = (options) => {
  const pins = options.pins ?? SCANNER_PINS;
  const assets = options.assets ?? SCANNER_ASSETS;
  const platform = options.platform === undefined ? currentPlatform() : options.platform;
  const download = options.download ?? defaultDownload;
  const extract = options.extract ?? defaultExtract;
  const pending = new Map<string, Promise<string>>();

  /**
   * The installed executable when it still has the pinned binary checksum, else `null`. The
   * manifest only says where the executable is; that path must stay inside the install and be a
   * regular file (not a symlink). Without a binary pin nothing installed is trusted.
   */
  const verified = (dir: string, binaryPin: string | undefined): string | null => {
    if (binaryPin === undefined) return null;
    const manifest = readManifest(dir);
    if (typeof manifest?.binary !== "string") return null;
    const binary = join(dir, manifest.binary);
    if (binary === dir || !isInsideDir(dir, binary)) return null;
    try {
      if (!lstatSync(binary).isFile()) return null;
      return sha256(readFileSync(binary)) === binaryPin ? binary : null;
    } catch {
      return null;
    }
  };

  const install = async (
    pin: ScannerPin,
    asset: string,
    expected: string,
    binaryPin: string | undefined,
    dir: string,
  ): Promise<string> => {
    const bytes = await download(scannerUrl(pin, asset));
    const actual = sha256(bytes);
    if (actual !== expected) {
      throw new ScannerError(
        pin.name,
        `checksum mismatch for ${asset}: expected ${expected}, got ${actual}; nothing was installed`,
      );
    }
    const parent = join(options.vtcHome, SCANNERS_DIR, pin.name, pin.version);
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const staging = join(parent, `.staging-${randomBytes(6).toString("hex")}`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      const names = [assets[pin.name]?.binary ?? pin.name].flatMap((n) => [n, `${n}.exe`]);
      const kind = archiveKind(asset);
      let binary: string;
      if (kind === "raw") {
        binary = join(
          staging,
          asset.endsWith(".exe") ? `${names[0] ?? pin.name}.exe` : (names[0] ?? pin.name),
        );
        writeFileSync(binary, bytes, { mode: 0o700 });
      } else {
        const archive = join(parent, `.download-${randomBytes(6).toString("hex")}`);
        writeFileSync(archive, bytes, { mode: 0o600 });
        try {
          extract(archive, kind, staging);
        } finally {
          rmSync(archive, { force: true });
        }
        const found = findBinary(staging, names);
        if (found === null)
          throw new ScannerError(pin.name, `no ${names.join(" or ")} in ${asset}`);
        binary = found;
      }
      chmodSync(binary, 0o700);
      const binarySha = sha256(readFileSync(binary));
      if (binaryPin !== undefined && binarySha !== binaryPin) {
        throw new ScannerError(
          pin.name,
          `binary checksum mismatch for ${asset}: expected ${binaryPin}, got ${binarySha}; nothing was installed`,
        );
      }
      const manifest: Manifest = {
        name: pin.name,
        version: pin.version,
        platform: platform as Platform,
        download_sha256: expected,
        binary: binary
          .slice(staging.length + 1)
          .split("\\")
          .join("/"),
        binary_sha256: binarySha,
      };
      writeFileSync(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
        mode: 0o600,
      });
      rmSync(dir, { recursive: true, force: true });
      renameSync(staging, dir);
      return join(dir, manifest.binary);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  };

  const ensure = (name: string): Promise<string> => {
    const pin = pins.scanners.find((s) => s.name === name);
    if (pin === undefined) return Promise.reject(new ScannerError(name, "not a pinned scanner"));
    if (platform === null) {
      return Promise.reject(
        new ScannerUnavailableError(name, `${process.platform}-${process.arch}`),
      );
    }
    const asset = assets[name]?.platforms[platform];
    const expected = pin.sha256[platform];
    if (asset === undefined || expected === undefined) {
      return Promise.reject(new ScannerUnavailableError(name, platform));
    }
    const dir = join(options.vtcHome, SCANNERS_DIR, name, pin.version, platform);
    const binaryPin = pin.binary_sha256?.[platform];
    const ok = verified(dir, binaryPin);
    if (ok !== null) return Promise.resolve(ok);
    const running = pending.get(name);
    if (running !== undefined) return running;
    const job = install(pin, asset, expected, binaryPin, dir).finally(() => pending.delete(name));
    pending.set(name, job);
    return job;
  };

  return { names: pins.scanners.map((s) => s.name), ensure };
};
