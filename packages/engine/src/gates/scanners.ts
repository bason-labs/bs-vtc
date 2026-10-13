/**
 * The pinned scanner store (§4.4, §7.2, §15): scanners are downloaded on demand into
 * `~/.vtc/scanners/<name>/<version>/<platform>/`, verified against the pinned SHA-256 before
 * anything is unpacked, and re-verified before every use. Nothing is auto-updated: a different
 * version only arrives with a new pin in a new vtc release.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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

/** Downloads bytes over https (following redirects). Injected in tests: they never download. */
export type Download = (url: string) => Promise<Uint8Array>;

/** Unpacks an archive into an empty directory. */
export type Extract = (archive: string, kind: "tar.gz" | "zip", into: string) => void;

export interface ScannerStoreOptions {
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

interface Manifest {
  readonly name: string;
  readonly version: string;
  readonly platform: Platform;
  readonly download_sha256: string;
  /** Path of the executable relative to the install directory. */
  readonly binary: string;
  readonly binary_sha256: string;
}

const readManifest = (dir: string): Manifest | null => {
  try {
    return JSON.parse(readFileSync(join(dir, MANIFEST), "utf8")) as Manifest;
  } catch {
    return null;
  }
};

export interface ScannerStore {
  /** Names of the pinned scanners (allowed by name, `gateCommandAllowed`). */
  readonly names: readonly string[];
  /** The verified executable of a pinned scanner, downloading it first when missing. */
  ensure(name: string): Promise<string>;
}

export const createScannerStore = (options: ScannerStoreOptions): ScannerStore => {
  const pins = options.pins ?? SCANNER_PINS;
  const assets = options.assets ?? SCANNER_ASSETS;
  const platform = options.platform === undefined ? currentPlatform() : options.platform;
  const download = options.download ?? defaultDownload;
  const extract = options.extract ?? defaultExtract;
  const pending = new Map<string, Promise<string>>();

  const verified = (dir: string, pin: ScannerPin, expected: string): string | null => {
    const manifest = readManifest(dir);
    if (manifest?.version !== pin.version || manifest.download_sha256 !== expected) return null;
    const binary = join(dir, manifest.binary);
    if (!existsSync(binary) || !statSync(binary).isFile()) return null;
    return sha256(readFileSync(binary)) === manifest.binary_sha256 ? binary : null;
  };

  const install = async (
    pin: ScannerPin,
    asset: string,
    expected: string,
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
      const manifest: Manifest = {
        name: pin.name,
        version: pin.version,
        platform: platform as Platform,
        download_sha256: expected,
        binary: binary
          .slice(staging.length + 1)
          .split("\\")
          .join("/"),
        binary_sha256: sha256(readFileSync(binary)),
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
        new ScannerError(name, `no pinned build for ${process.platform}-${process.arch}`),
      );
    }
    const asset = assets[name]?.platforms[platform];
    const expected = pin.sha256[platform];
    if (asset === undefined || expected === undefined) {
      return Promise.reject(
        new ScannerError(
          name,
          `no pinned build for ${platform}; install it yourself and confirm it in vtc calibrate`,
        ),
      );
    }
    const dir = join(options.vtcHome, SCANNERS_DIR, name, pin.version, platform);
    const ok = verified(dir, pin, expected);
    if (ok !== null) return Promise.resolve(ok);
    const running = pending.get(name);
    if (running !== undefined) return running;
    const job = install(pin, asset, expected, dir).finally(() => pending.delete(name));
    pending.set(name, job);
    return job;
  };

  return { names: pins.scanners.map((s) => s.name), ensure };
};
