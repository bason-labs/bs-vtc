/**
 * The pinned scanner store (§4.4, §7.2, §15) with fake downloads: nothing is ever fetched from
 * the network in tests. Also keeps the embedded pins and rules equal to `gates/`.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HIDDEN_TESTS, ROLE_DENIED_VTC, ScannerPinsSchema, type ScannerPins } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  createScannerStore,
  currentPlatform,
  OSV_DB_DIR,
  ScannerUnavailableError,
  type ScannerStore,
  type ScannerStoreOptions,
  ensureRules,
  PRODUCT_RULES,
  SCANNER_ASSETS,
  SCANNER_PINS,
  scannerUrl,
} from "../../src/gates/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const ROOT = join(import.meta.dirname, "../../../..");
const sha = (bytes: Uint8Array | string): string =>
  createHash("sha256").update(bytes).digest("hex");

describe("embedded pins and rules match gates/", () => {
  it("gates/scanners.json equals the embedded pins and every pin has its assets", () => {
    const file = ScannerPinsSchema.parse(
      JSON.parse(readFileSync(join(ROOT, "gates/scanners.json"), "utf8")),
    );
    expect(file).toEqual(SCANNER_PINS);
    for (const pin of SCANNER_PINS.scanners) {
      const assets = SCANNER_ASSETS[pin.name];
      expect(assets, pin.name).toBeDefined();
      expect(Object.keys(assets?.platforms ?? {}).sort()).toEqual(Object.keys(pin.sha256).sort());
      expect(pin.license).not.toMatch(/^A?GPL/);
    }
  });
  it("gates/rules equals the embedded ruleset, and every rule is MIT with a pattern", () => {
    const dir = join(ROOT, "gates/rules");
    const files = readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name).slice(dir.length + 1));
    expect(files.sort()).toEqual(Object.keys(PRODUCT_RULES).sort());
    for (const name of files) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).toBe(PRODUCT_RULES[name]);
      const doc = parse(text) as { rules: Record<string, unknown>[] };
      for (const rule of doc.rules) {
        expect(String(rule.id)).toMatch(/^vtc\./);
        expect(typeof rule.message).toBe("string");
        expect((rule.metadata as { license?: string }).license).toBe("MIT");
        expect(["pattern", "patterns", "pattern-either"].some((k) => k in rule)).toBe(true);
      }
    }
  });
  it("builds release URLs from the template", () => {
    const gitleaks = SCANNER_PINS.scanners.find((s) => s.name === "gitleaks");
    expect(gitleaks && scannerUrl(gitleaks, "darwin_arm64.tar.gz")).toBe(
      "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_darwin_arm64.tar.gz",
    );
  });
  it("maps this machine to a download target", () => {
    expect(currentPlatform("darwin", "arm64")).toBe("darwin-arm64");
    expect(currentPlatform("linux", "x64")).toBe("linux-x64");
    expect(currentPlatform("win32", "x64")).toBe("windows-x64");
    expect(currentPlatform("freebsd", "x64")).toBeNull();
  });
});

const FAKE = "#!/bin/sh\necho fake-scanner\n";

const pinsFor = (
  bytes: Uint8Array,
  url = "https://example.test/{version}/fake_{platform}",
): ScannerPins =>
  ScannerPinsSchema.parse({
    version: 1,
    scanners: [
      {
        name: "fake",
        version: "1.0.0",
        url,
        sha256: { "darwin-arm64": sha(bytes) },
        license: "MIT",
      },
    ],
  });

describe("scanner store", () => {
  it("downloads once, verifies the SHA-256 and reuses the verified binary", async () => {
    const home = tempDir();
    const bytes = new TextEncoder().encode(FAKE);
    const urls: string[] = [];
    const store = createScannerStore({
      vtcHome: home,
      platform: "darwin-arm64",
      pins: pinsFor(bytes),
      assets: { fake: { binary: "fake", platforms: { "darwin-arm64": "darwin_arm64" } } },
      download: (url) => {
        urls.push(url);
        return Promise.resolve(bytes);
      },
    });
    const binary = await store.ensure("fake");
    expect(binary).toBe(join(home, "scanners/fake/1.0.0/darwin-arm64/fake"));
    expect(readFileSync(binary, "utf8")).toBe(FAKE);
    expect(await store.ensure("fake")).toBe(binary);
    expect(urls).toEqual(["https://example.test/1.0.0/fake_darwin_arm64"]);
    writeFileSync(binary, "#!/bin/sh\necho tampered\n");
    expect(await store.ensure("fake")).toBe(binary);
    expect(readFileSync(binary, "utf8")).toBe(FAKE);
    expect(urls).toHaveLength(2);
  });

  it("refuses a download whose checksum does not match and installs nothing", async () => {
    const home = tempDir();
    const store = createScannerStore({
      vtcHome: home,
      platform: "darwin-arm64",
      pins: pinsFor(new TextEncoder().encode(FAKE)),
      assets: { fake: { binary: "fake", platforms: { "darwin-arm64": "darwin_arm64" } } },
      download: () => Promise.resolve(new TextEncoder().encode("evil")),
    });
    await expect(store.ensure("fake")).rejects.toThrow(/checksum mismatch/);
    expect(existsSync(join(home, "scanners/fake/1.0.0/darwin-arm64"))).toBe(false);
  });

  it("unpacks a tar.gz and finds the executable inside", async () => {
    const home = tempDir();
    const src = tempDir();
    mkdirSync(join(src, "pkg/bin"), { recursive: true });
    writeFileSync(join(src, "pkg/bin/fake"), FAKE, { mode: 0o755 });
    writeFileSync(join(src, "pkg/LICENSE"), "MIT\n");
    const archive = join(src, "fake.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", src, "pkg"]);
    const bytes = new Uint8Array(readFileSync(archive));
    const store = createScannerStore({
      vtcHome: home,
      platform: "darwin-arm64",
      pins: pinsFor(bytes),
      assets: { fake: { binary: "fake", platforms: { "darwin-arm64": "darwin_arm64.tar.gz" } } },
      download: () => Promise.resolve(bytes),
    });
    const binary = await store.ensure("fake");
    expect(binary.endsWith("pkg/bin/fake")).toBe(true);
    expect(execFileSync(binary, { encoding: "utf8" }).trim()).toBe("fake-scanner");
  });

  it("explains unpinned scanners and platforms", async () => {
    const store = createScannerStore({ vtcHome: tempDir(), platform: "darwin-arm64" });
    await expect(store.ensure("nope")).rejects.toThrow(/not a pinned scanner/);
    await expect(store.ensure("checkov")).rejects.toThrow(/no pinned build for darwin-arm64/);
    expect(store.names).toEqual(["gitleaks", "osv-scanner", "opengrep", "checkov"]);
  });

  it("marks a scanner with no build for this platform as user-installed there (D-u)", async () => {
    const download = (): Promise<Uint8Array> => Promise.reject(new Error("never downloads"));
    const store = createScannerStore({ vtcHome: tempDir(), platform: "darwin-arm64", download });
    const error: unknown = await store.ensure("checkov").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ScannerUnavailableError);
    expect(error).toMatchObject({ scanner: "checkov", platform: "darwin-arm64" });
    // Nothing confirms or records the user's binary, and the message says what will run instead.
    expect(String(error)).not.toMatch(/confirm/);
    expect(String(error)).toMatch(/first checkov on an absolute PATH entry outside the repo/);
    expect(String(error)).toMatch(/does not checksum-verify/);
    const nowhere = createScannerStore({ vtcHome: tempDir(), platform: null, download });
    const gitleaks: unknown = await nowhere.ensure("gitleaks").catch((e: unknown) => e);
    expect(gitleaks).toBeInstanceOf(ScannerUnavailableError);
    // Only user-installable scanners are told to install themselves.
    expect(String(gitleaks)).not.toMatch(/install it yourself/);
    // Platforms with a native build keep their pin.
    const linux = createScannerStore({ vtcHome: tempDir(), platform: "linux-arm64", download });
    const pinned: unknown = await linux.ensure("checkov").catch((e: unknown) => e);
    expect(pinned).not.toBeInstanceOf(ScannerUnavailableError);
    expect(String(pinned)).toMatch(/never downloads/);
  });

  it("is typed for doctor: { vtcHome, download? } in, { names, ensure } out", async () => {
    const options: ScannerStoreOptions = {
      vtcHome: tempDir(),
      download: () => Promise.reject(new Error("offline")),
    };
    const store: ScannerStore = createScannerStore(options);
    expect(store.names).toContain("gitleaks");
    await expect(store.ensure("gitleaks")).rejects.toThrow();
  });

  it("keeps the osv database where the role deny list protects it (D-w)", () => {
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain(`${OSV_DB_DIR}/**`);
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain(`${HIDDEN_TESTS.homeDir}/**`);
  });

  it("writes the product ruleset under the VTC home", () => {
    const home = tempDir();
    const dir = ensureRules(home);
    expect(readFileSync(join(dir, "opengrep/vtc-security.yml"), "utf8")).toBe(
      PRODUCT_RULES["opengrep/vtc-security.yml"],
    );
    expect(ensureRules(home)).toBe(dir);
  });
});
