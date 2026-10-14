/**
 * `vtc doctor --install-browser` (spine AD-24, §5 readings 96 and 106; D-ay; owner: cli+binary
 * team). An explicit user command, never run silently: it installs the visual stack's browser
 * into `~/.vtc/browsers/` (`BROWSERS_DIR`, used as `PLAYWRIGHT_BROWSERS_PATH`) for projects that
 * have no Playwright of their own, and records the `BrowserPin` the visual step re-verifies before
 * every run (`BROWSER_PIN_FILE`).
 *
 * 1. Downloads each pinned npm package ({@link BROWSER_PACKAGES}: `playwright-core`, and the
 *    unmodified `axe-core`, `pixelmatch` and `pngjs` the visual runner loads from the store, never
 *    from the binary) over HTTPS, verifies its npm `integrity` (SHA-512) before unpacking, and
 *    moves it into `browsers/node_modules/<name>`.
 * 2. Runs the verified `playwright-core` installer for the headless shell only
 *    (`install --only-shell chromium`) with `PLAYWRIGHT_BROWSERS_PATH` set to the store.
 *    Playwright's CDN publishes no checksum for the browser (spine §5 reading 55), so the pin is
 *    the SHA-256 of the executable as installed: any later change to it is caught.
 * 3. Writes the pin (`source: vtc`, the `playwright-core` version and integrity, the executable
 *    and its SHA-256).
 *
 * Every step is injectable; tests never download a browser.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  BROWSER_PIN_FILE,
  BrowserPinSchema,
  BROWSERS_DIR,
  parsePersisted,
  type BrowserPin,
} from "@vtc/shared";
import type { DoctorCheck } from "./doctor-checks.js";
import { exec, type ExecResult } from "./process.js";

export interface PinnedPackage {
  readonly name: string;
  readonly version: string;
  /** npm `dist.integrity`. */
  readonly integrity: string;
}

/**
 * The packages the store holds, pinned by version and npm integrity (read from the registry's
 * metadata when they were pinned). `playwright-core` (Apache-2.0) installs and drives the browser;
 * `axe-core` (MPL-2.0, never modified or bundled, reading 106), `pixelmatch` (ISC; v8, whose
 * threshold `VISUAL_DEFAULTS` follows) and its dependency `pngjs` (MIT) are what the visual runner
 * injects or loads.
 */
export const PLAYWRIGHT_CORE: PinnedPackage = {
  name: "playwright-core",
  version: "1.63.0",
  integrity:
    "sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==",
};

export const BROWSER_PACKAGES: readonly PinnedPackage[] = [
  PLAYWRIGHT_CORE,
  {
    name: "axe-core",
    version: "4.13.0",
    integrity:
      "sha512-UzGt8zg7Ny8djbYMhxl2zuEevVa7r2gJjYY5Lwr1xM7+XU2nd6CkIWFTVcCIbAP63vSz71NaVyyuSk9lHKcy0A==",
  },
  {
    name: "pixelmatch",
    version: "8.0.0",
    integrity:
      "sha512-cIqOLfh5k52us715qf3B3+kTOxZv+WDv77HN7xokLScYQGYQHi4m/ynoDIPpvF2LvCyUJGyvzY64i0QCXtzu1g==",
  },
  {
    name: "pngjs",
    version: "7.0.0",
    integrity:
      "sha512-LKWqWJRhstyYo9pGvgor/ivk2w94eSjE3RGVuzLGlr3NmD8bf7RcYGze1mNdEHRP6TRP6rMuDHk5t44hnTRyow==",
  },
];

/** The browser Playwright installs with `--only-shell` (its `browsers.json` name). */
export const HEADLESS_SHELL = "chromium-headless-shell";

/** The registry tarball of a package. */
export const tarballUrl = (pkg: Pick<PinnedPackage, "name" | "version">): string =>
  `https://registry.npmjs.org/${pkg.name}/-/${pkg.name}-${pkg.version}.tgz`;

/** Pure: whether `bytes` match an npm `sha512-<base64>` integrity string. */
export const matchesIntegrity = (bytes: Uint8Array, integrity: string): boolean => {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (match === null) return false;
  return createHash("sha512").update(bytes).digest("base64") === match[1];
};

export interface BrowserInstallDeps {
  /** Fetches an https URL (at most `maxBytes`). */
  readonly download: (url: string, maxBytes: number) => Promise<Uint8Array>;
  /** Unpacks an npm tarball (`package/…`) into `dir`. */
  readonly extract: (tarball: string, dir: string) => Promise<void>;
  /** Runs `<node> <cli.js> install --only-shell chromium` with `PLAYWRIGHT_BROWSERS_PATH`. */
  readonly runInstaller: (cliJs: string, browsersPath: string) => Promise<ExecResult>;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

/** A plain HTTPS download with a byte cap (the integrity check is what trusts the bytes). */
export const httpsDownload = async (url: string, maxBytes: number): Promise<Uint8Array> => {
  if (!url.startsWith("https://")) throw new Error(`only https downloads: ${url}`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`GET ${url}: HTTP ${String(response.status)}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (body.byteLength > maxBytes)
    throw new Error(`${url} is larger than ${String(maxBytes)} bytes`);
  return body;
};

/** The system `tar` (macOS, Linux and Windows 10+ ship one). */
export const tarExtract = async (tarball: string, dir: string): Promise<void> => {
  const result = await exec("tar", ["-xzf", tarball, "-C", dir, "--strip-components", "1"], {
    timeoutMs: 120_000,
  });
  if (result.code !== 0)
    throw new Error(`tar could not unpack ${tarball}: ${(result.error ?? result.stderr).trim()}`);
};

/** The Node that runs Playwright's installer: this one in development, `node` on PATH in the binary. */
export const nodeCommand = (): string =>
  process.versions.bun === undefined ? process.execPath : "node";

export const playwrightInstaller = (cliJs: string, browsersPath: string): Promise<ExecResult> =>
  exec(nodeCommand(), [cliJs, "install", "--only-shell", "chromium"], {
    timeoutMs: 15 * 60_000,
    env: { PLAYWRIGHT_BROWSERS_PATH: browsersPath },
  });

export const defaultBrowserInstallDeps = (log: (line: string) => void): BrowserInstallDeps => ({
  download: httpsDownload,
  extract: tarExtract,
  runInstaller: playwrightInstaller,
  now: () => new Date(),
  log,
});

const MARKER = ".vtc-integrity";

const refuseLink = (path: string): void => {
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new Error(`${path} is a symbolic link: refusing it`);
};

/** Installs one package into `node_modules/<name>`, unless that exact verified version is there. */
const installPackage = async (
  store: string,
  pkg: PinnedPackage,
  deps: BrowserInstallDeps,
): Promise<void> => {
  const modules = join(store, "node_modules");
  mkdirSync(modules, { recursive: true });
  refuseLink(modules);
  const target = join(modules, pkg.name);
  refuseLink(target);
  const marker = join(target, MARKER);
  if (existsSync(marker) && readFileSync(marker, "utf8").trim() === pkg.integrity) {
    deps.log(`  ${pkg.name}@${pkg.version}: already installed and verified`);
    return;
  }
  const url = tarballUrl(pkg);
  deps.log(`  ${pkg.name}@${pkg.version}: downloading ${url}`);
  const bytes = await deps.download(url, MAX_TARBALL_BYTES);
  if (!matchesIntegrity(bytes, pkg.integrity))
    throw new Error(
      `${pkg.name}@${pkg.version} does not match its pinned integrity: nothing was installed`,
    );
  const staging = join(store, `.staging-${pkg.name}-${randomBytes(4).toString("hex")}`);
  const tarball = `${staging}.tgz`;
  mkdirSync(staging);
  try {
    writeFileSync(tarball, bytes, { mode: 0o600 });
    await deps.extract(tarball, staging);
    const manifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    if (manifest.name !== pkg.name || manifest.version !== pkg.version)
      throw new Error(`${url} unpacked to something other than ${pkg.name}@${pkg.version}`);
    writeFileSync(join(staging, MARKER), `${pkg.integrity}\n`);
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(tarball, { force: true });
  }
};

const EXECUTABLES = new Set([
  "chrome-headless-shell",
  "chrome-headless-shell.exe",
  "headless_shell",
  "headless_shell.exe",
]);

/** The headless shell's executable under `dir` (searched a few levels deep), or `null`. */
export const findExecutable = (dir: string, depth = 3): string | null => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries)
    if (entry.isFile() && EXECUTABLES.has(entry.name)) return join(dir, entry.name);
  if (depth === 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findExecutable(join(dir, entry.name), depth - 1);
    if (found !== null) return found;
  }
  return null;
};

/** SHA-256 of a file, streamed (a browser is large). */
export const sha256OfFile = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex"));
      });
  });

interface BrowsersJson {
  readonly browsers?: readonly {
    readonly name?: string;
    readonly revision?: string;
    readonly browserVersion?: string;
  }[];
}

export const pinPath = (vtcHome: string): string => join(vtcHome, BROWSER_PIN_FILE);

const writeAtomic = (path: string, text: string): void => {
  refuseLink(path);
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o644);
  try {
    writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
};

/** Installs the store and writes the pin; resolves the pin. Throws with what went wrong. */
export const installBrowser = async (
  vtcHome: string,
  deps: BrowserInstallDeps,
  packages: readonly PinnedPackage[] = BROWSER_PACKAGES,
): Promise<BrowserPin> => {
  const playwright = packages.find((p) => p.name === PLAYWRIGHT_CORE.name);
  if (playwright === undefined) throw new Error("the browser store needs playwright-core");
  const store = join(vtcHome, BROWSERS_DIR);
  refuseLink(vtcHome);
  mkdirSync(store, { recursive: true });
  refuseLink(store);
  deps.log(`Installing the visual stack's browser into ${store} (explicit, verified):`);
  for (const pkg of packages) await installPackage(store, pkg, deps);
  const core = join(store, "node_modules", "playwright-core");
  deps.log(`  ${HEADLESS_SHELL}: running playwright-core's installer`);
  const result = await deps.runInstaller(join(core, "cli.js"), store);
  if (result.code !== 0)
    throw new Error(
      `playwright-core's installer failed${result.error === undefined ? "" : ` (${result.error})`}: ${result.stderr.trim().slice(-500)}`,
    );
  const browsers = JSON.parse(readFileSync(join(core, "browsers.json"), "utf8")) as BrowsersJson;
  const shell = browsers.browsers?.find((b) => b.name === HEADLESS_SHELL);
  if (shell?.revision === undefined || shell.browserVersion === undefined)
    throw new Error(`playwright-core's browsers.json names no ${HEADLESS_SHELL}`);
  const executable = findExecutable(join(store, `chromium_headless_shell-${shell.revision}`));
  if (executable === null)
    throw new Error(`no ${HEADLESS_SHELL} executable under ${store} after the install`);
  const pin = BrowserPinSchema.parse({
    v: 1,
    source: "vtc",
    name: HEADLESS_SHELL,
    version: shell.browserVersion,
    playwright_core_version: playwright.version,
    package_integrity: playwright.integrity,
    executable,
    executable_sha256: await sha256OfFile(executable),
    installed_at: deps.now().toISOString(),
  } satisfies Partial<BrowserPin>);
  writeAtomic(pinPath(vtcHome), `${JSON.stringify(pin, null, 2)}\n`);
  deps.log(`  pinned ${executable} (${pin.executable_sha256.slice(0, 12)}…)`);
  return pin;
};

/** What the doctor check reads. */
export interface BrowserCheckEnv {
  readonly vtcHome: string;
  readonly sha256: (path: string) => Promise<string>;
}

/**
 * The visual stack's browser (AD-24 rule 2): the pin `--install-browser` wrote, and whether the
 * executable still matches it. No pin is a warning (the visual gates are skipped unless the
 * project has its own Playwright); a mismatch fails, because every visual run would be gate
 * infrastructure (`error`) until it is reinstalled.
 */
export const checkBrowser = async (env: BrowserCheckEnv): Promise<DoctorCheck> => {
  const name = "browser";
  const fix = "run vtc doctor --install-browser";
  const path = pinPath(env.vtcHome);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return {
      name,
      status: "warn",
      detail: `no browser installed by vtc: the visual gates use the project's own Playwright, or are skipped with "no browser"; to install one, ${fix}`,
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const parsed = parsePersisted(BrowserPinSchema, raw);
  if (!parsed.success) return { name, status: "fail", detail: `${path} does not parse: ${fix}` };
  const pin = parsed.data;
  let actual: string;
  try {
    actual = await env.sha256(pin.executable);
  } catch {
    return {
      name,
      status: "fail",
      detail: `the pinned browser ${pin.executable} is missing, so visual gates error: ${fix}`,
    };
  }
  return actual === pin.executable_sha256
    ? {
        name,
        status: "ok",
        detail: `${pin.name} ${pin.version} (playwright-core ${pin.playwright_core_version}), matches its pin`,
      }
    : {
        name,
        status: "fail",
        detail: `${pin.executable} no longer matches its pin, so visual gates error: ${fix}`,
      };
};
