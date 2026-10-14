/**
 * Where the visual step's Playwright, browser, axe-core and pixelmatch come from (D-ay, spine §5
 * readings 96 and 106; AD-24 rules 1, 2 and 6), and the browser pin check before every run.
 *
 * - The project's own: `playwright-core` (directly or through `playwright` / `@playwright/test`)
 *   resolved inside the verification checkout, and the browser in the user's Playwright cache.
 *   `axe-core` and `pixelmatch` come from the checkout, else from the doctor-installed store
 *   (reading 106). Its executable is pinned on first use, per repo and per executable path, under
 *   `~/.vtc/browsers/projects/<repo-key>/<path-hash>.json`: a path seen before is always
 *   re-verified and never re-pinned, so a later run whose executable at that path hashes
 *   differently is gate infrastructure (`error`), and an unreadable pin fails closed. A first-use
 *   pin is a visible note in the report.
 * - The store `vtc doctor --install-browser` filled: packages under `~/.vtc/browsers/node_modules/`
 *   and the browser it pinned in `BROWSER_PIN_FILE` (`source: vtc`), re-verified the same way.
 * - Neither: the step is `skipped` with `VISUAL_SKIPPED_NO_BROWSER`. Nothing is ever downloaded
 *   here, and axe-core is never embedded: it is injected unmodified from one of the two places.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  BROWSER_PIN_FILE,
  BROWSERS_DIR,
  BrowserPinSchema,
  engineRepoKey,
  parsePersisted,
  type BrowserPin,
} from "@vtc/shared";
import { writeRepoFile } from "../../git/index.js";

/** The npm-style prefix `vtc doctor --install-browser` installs packages into, under the VTC home. */
export const BROWSER_STORE_NODE_MODULES = `${BROWSERS_DIR}/node_modules`;
/** Per-repo pins of the projects' own browsers, under the VTC home. */
export const PROJECT_BROWSER_PINS_DIR = `${BROWSERS_DIR}/projects`;

export interface VisualToolchain {
  readonly source: "project" | "vtc";
  /** Absolute entry file of `playwright-core` (or `playwright`) to import. */
  readonly playwright: string;
  readonly playwrightVersion: string;
  /** Absolute `axe.min.js`, or `null` when there is none. */
  readonly axe: string | null;
  /** Absolute entry of `pixelmatch`, or `null`. */
  readonly pixelmatch: string | null;
  /** `PLAYWRIGHT_BROWSERS_PATH` for the runner: where the browser lives (readable in the sandbox). */
  readonly browsersPath: string;
  /** Absolute directories the sandboxed runner must read besides the checkout. */
  readonly readable: readonly string[];
}

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

const real = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const readJson = (path: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The entry file of a package directory: `exports` (import/default), `main`, `index.js`. */
export const packageEntry = (dir: string): string | null => {
  const pkg = readJson(join(dir, "package.json"));
  if (pkg === null) return null;
  const pick = (value: unknown): string | null => {
    if (typeof value === "string") return value;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const v = value as Record<string, unknown>;
    return pick(v["."] ?? v.import ?? v.node ?? v.default ?? v.require);
  };
  const entry = pick(pkg.exports) ?? (typeof pkg.main === "string" ? pkg.main : "index.js");
  const abs = join(dir, entry);
  return existsSync(abs) ? abs : null;
};

/**
 * The directory of package `name` as Node's `node_modules` lookup finds it from directory `from`
 * (its real path, then each parent's `node_modules`), only when it lies inside `root`:
 * resolution never escapes the verification checkout or the store.
 */
export const resolvePackageDir = (root: string, from: string, name: string): string | null => {
  const rootReal = real(root);
  const start = real(from);
  if (rootReal === null || start === null) return null;
  for (let dir = start; inside(rootReal, dir); dir = dirname(dir)) {
    if (basename(dir) !== "node_modules") {
      const candidate = join(dir, "node_modules", name);
      const pkg = readJson(join(candidate, "package.json"));
      const realDir = real(candidate);
      if (pkg !== null && realDir !== null) {
        return pkg.name === name && inside(rootReal, realDir) ? realDir : null;
      }
    }
    if (dir === dirname(dir)) break;
  }
  return null;
};

const versionOf = (dir: string): string => {
  const v = readJson(join(dir, "package.json"))?.version;
  return typeof v === "string" ? v : "unknown";
};

/** The project's Playwright cache (`PLAYWRIGHT_BROWSERS_PATH` or the platform default). */
export const projectBrowsersPath = (
  env: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string => {
  const configured = env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured !== undefined && isAbsolute(configured)) return configured;
  if (platform === "darwin") return join(home, "Library", "Caches", "ms-playwright");
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright");
  }
  const xdg = env.XDG_CACHE_HOME;
  return join(xdg !== undefined && isAbsolute(xdg) ? xdg : join(home, ".cache"), "ms-playwright");
};

const playwrightIn = (root: string, from: string): { dir: string; entry: string } | null => {
  const direct = resolvePackageDir(root, from, "playwright-core");
  const viaPlaywright = (): string | null => {
    for (const parent of ["playwright", "@playwright/test"]) {
      const dir = resolvePackageDir(root, from, parent);
      if (dir === null) continue;
      const core = resolvePackageDir(root, dir, "playwright-core");
      if (core !== null) return core;
      if (parent === "@playwright/test") {
        const pw = resolvePackageDir(root, dir, "playwright");
        const nested = pw === null ? null : resolvePackageDir(root, pw, "playwright-core");
        if (nested !== null) return nested;
      }
    }
    return null;
  };
  const dir = direct ?? viaPlaywright();
  if (dir === null) return null;
  const entry = packageEntry(dir);
  return entry === null ? null : { dir, entry };
};

const axeIn = (root: string, from: string): string | null => {
  let dir = resolvePackageDir(root, from, "axe-core");
  if (dir === null) {
    const wrapper = resolvePackageDir(root, from, "@axe-core/playwright");
    dir = wrapper === null ? null : resolvePackageDir(root, wrapper, "axe-core");
  }
  const file = dir === null ? null : join(dir, "axe.min.js");
  return file !== null && existsSync(file) ? file : null;
};

const pixelmatchIn = (root: string, from: string): string | null => {
  const dir = resolvePackageDir(root, from, "pixelmatch");
  return dir === null ? null : packageEntry(dir);
};

/**
 * The project's own Playwright in the checkout, or `null`. axe-core and pixelmatch come from the
 * checkout, else from the doctor-installed store under `vtcHome` (reading 106), which is then
 * readable in the sandbox too.
 */
export const projectToolchain = (
  checkoutAbs: string,
  env: Readonly<Record<string, string | undefined>>,
  vtcHome?: string,
): VisualToolchain | null => {
  const pw = playwrightIn(checkoutAbs, checkoutAbs);
  if (pw === null) return null;
  const browsersPath = projectBrowsersPath(env);
  const store = vtcHome === undefined ? null : join(vtcHome, BROWSERS_DIR);
  let axe = axeIn(checkoutAbs, checkoutAbs);
  let pixelmatch = pixelmatchIn(checkoutAbs, checkoutAbs);
  let fromStore = false;
  if (store !== null && axe === null) {
    axe = axeIn(store, store);
    fromStore ||= axe !== null;
  }
  if (store !== null && pixelmatch === null) {
    pixelmatch = pixelmatchIn(store, store);
    fromStore ||= pixelmatch !== null;
  }
  return {
    source: "project",
    playwright: pw.entry,
    playwrightVersion: versionOf(pw.dir),
    axe,
    pixelmatch,
    browsersPath,
    readable: fromStore && store !== null ? [browsersPath, store] : [browsersPath],
  };
};

/** The doctor-installed store under the VTC home, or `null` when it has no Playwright. */
export const storeToolchain = (vtcHome: string): VisualToolchain | null => {
  const store = join(vtcHome, BROWSERS_DIR);
  const pw = playwrightIn(store, store);
  if (pw === null) return null;
  return {
    source: "vtc",
    playwright: pw.entry,
    playwrightVersion: versionOf(pw.dir),
    axe: axeIn(store, store),
    pixelmatch: pixelmatchIn(store, store),
    browsersPath: store,
    readable: [store],
  };
};

/** SHA-256 of a file, streamed (a browser executable is large). */
export const sha256File = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => {
        resolve(hash.digest("hex"));
      });
  });

/** A pin file: the pin, `null` when there is none, or the reason it cannot be read. */
export const readBrowserPin = (path: string): BrowserPin | null | { invalid: string } => {
  if (!existsSync(path)) return null;
  const raw = readJson(path);
  if (raw === null) return { invalid: `${path} is not JSON` };
  const parsed = parsePersisted(BrowserPinSchema, raw);
  return parsed.success
    ? parsed.data
    : { invalid: `${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
};

export type BrowserCheck =
  | { readonly ok: true; readonly pin: BrowserPin; readonly note?: string }
  | { readonly ok: false; readonly reason: string };

/**
 * AD-24 rule 2: the executable must still hash to its pin, and must lie where its source keeps
 * browsers (`within`). Never launches anything.
 */
export const verifyPinnedBrowser = async (
  pin: BrowserPin,
  within: string,
): Promise<BrowserCheck> => {
  const exe = real(pin.executable);
  const root = real(within);
  if (exe === null || !statSync(exe).isFile()) {
    return {
      ok: false,
      reason: `the pinned browser ${pin.executable} is missing; run vtc doctor --install-browser`,
    };
  }
  if (root === null || !inside(root, exe)) {
    return { ok: false, reason: `the pinned browser ${pin.executable} is outside ${within}` };
  }
  const actual = await sha256File(exe);
  return actual === pin.executable_sha256
    ? { ok: true, pin }
    : {
        ok: false,
        reason: `the browser ${pin.executable} does not match its pin (sha256 ${actual.slice(0, 12)}, pinned ${pin.executable_sha256.slice(0, 12)}): it changed since it was pinned, so nothing ran; reinstall it with vtc doctor --install-browser`,
      };
};

/**
 * `~/.vtc/browsers/projects/<repo-key>/<path-hash>.json`: one pin per repo and executable path
 * (the real path), so a path seen before is always re-verified, never re-pinned.
 */
export const projectPinPath = (vtcHome: string, repoRoot: string, executable: string): string =>
  join(
    vtcHome,
    PROJECT_BROWSER_PINS_DIR,
    engineRepoKey(repoRoot),
    `${createHash("sha256").update(executable).digest("hex").slice(0, 32)}.json`,
  );

/**
 * The project's browser at `executable` checked against its pin for that path. A path without a
 * pin is pinned on first use (a Playwright upgrade moves the executable) and the result carries
 * a `note` the report shows; a path with a pin is re-verified (AD-24 rule 2); an unreadable pin
 * or one recorded for another path fails closed.
 */
export const checkProjectBrowser = async (options: {
  readonly vtcHome: string;
  readonly repoRoot: string;
  readonly executable: string;
  readonly browsersPath: string;
  readonly name: string;
  readonly version: string;
  readonly playwrightVersion: string;
  readonly now: Date;
}): Promise<BrowserCheck | null> => {
  const exe = real(options.executable);
  const root = real(options.browsersPath);
  if (exe === null || root === null || !inside(root, exe) || !statSync(exe).isFile()) return null;
  const path = projectPinPath(options.vtcHome, options.repoRoot, exe);
  const existing = readBrowserPin(path);
  if (existing !== null) {
    if ("invalid" in existing) {
      return { ok: false, reason: `the project's browser pin is unreadable: ${existing.invalid}` };
    }
    if (existing.executable !== exe) {
      return {
        ok: false,
        reason: `the project's browser pin ${path} records ${existing.executable}, not ${exe}`,
      };
    }
    return verifyPinnedBrowser(existing, options.browsersPath);
  }
  const pin = BrowserPinSchema.parse({
    v: 1,
    source: "project",
    name: options.name,
    version: options.version,
    playwright_core_version: options.playwrightVersion,
    executable: exe,
    executable_sha256: await sha256File(exe),
    installed_at: options.now.toISOString(),
  });
  const rel = relative(options.vtcHome, path).split(sep).join("/");
  writeRepoFile(options.vtcHome, rel, `${JSON.stringify(pin, null, 2)}\n`, 0o600);
  return {
    ok: true,
    pin,
    note: `pinned the project's browser ${exe} (sha256 ${pin.executable_sha256.slice(0, 12)}) on first use`,
  };
};

/** The doctor-installed browser's pin (`BROWSER_PIN_FILE`), checked. `null`: no pin. */
export const checkStoreBrowser = async (vtcHome: string): Promise<BrowserCheck | null> => {
  const pin = readBrowserPin(join(vtcHome, BROWSER_PIN_FILE));
  if (pin === null) return null;
  if ("invalid" in pin)
    return { ok: false, reason: `the browser pin is unreadable: ${pin.invalid}` };
  return verifyPinnedBrowser(pin, join(vtcHome, BROWSERS_DIR));
};

/** The browser name and version Playwright's `browsers.json` records for Chromium. */
export const chromiumOf = (playwrightEntry: string): { name: string; version: string } => {
  for (let dir = dirname(playwrightEntry); dir !== dirname(dir); dir = dirname(dir)) {
    const browsers = readJson(join(dir, "browsers.json"))?.browsers;
    if (!Array.isArray(browsers)) {
      if (existsSync(join(dir, "package.json"))) break;
      continue;
    }
    for (const b of browsers as unknown[]) {
      const entry = b as { name?: unknown; browserVersion?: unknown; revision?: unknown };
      if (entry.name === "chromium") {
        const version =
          typeof entry.browserVersion === "string"
            ? entry.browserVersion
            : typeof entry.revision === "string"
              ? entry.revision
              : "unknown";
        return { name: "chromium", version };
      }
    }
    break;
  }
  return { name: "chromium", version: "unknown" };
};
