/**
 * The cli's `AssetBundle` (AD-2 rule 7, AD-20): from disk in development, from embedded files in
 * the binary; the engine resolves dashboard URLs against it; plugins are extracted to the VTC
 * home for `HostAdapter.install`.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { core } from "@vtc/engine";
import {
  ASSET_SOURCES,
  CONTRACTS_VERSION,
  extractedPluginDir,
  PLUGIN_MANIFEST_ASSET,
  resolveDashboardAsset,
  ROLE_CONTRACTS_ASSET,
} from "@vtc/shared";
import {
  createDiskAssetBundle,
  createEmbeddedAssetBundle,
  devAssetRoots,
  extractNamespace,
} from "../src/assets.js";
import { binaryRuntime, devRuntime, productRoot } from "../src/runtime.js";
import { VERSION } from "../src/version.js";
import {
  DASHBOARD_FIXTURE,
  PRODUCT_ROOT,
  cleanupDirs,
  tempDir,
  writePluginTrees,
} from "./helpers.js";

afterEach(cleanupDirs);

const text = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

describe("the development bundle (ASSET_SOURCES on disk)", () => {
  it("resolves ASSET_SOURCES against the product repo", () => {
    expect(productRoot()).toBe(PRODUCT_ROOT);
    expect(devAssetRoots("/p")).toEqual({
      dashboard: `/p/${ASSET_SOURCES.dashboard}`,
      "plugin:claude-code": `/p/${ASSET_SOURCES["plugin:claude-code"]}`,
      "plugin:codex": `/p/${ASSET_SOURCES["plugin:codex"]}`,
    });
    expect(devRuntime("/p").pluginDir("codex", "/h")).toBe("/p/dist/codex-plugin");
  });

  it("serves the dashboard export by AD-20's mapping", () => {
    const bundle = createDiskAssetBundle({ dashboard: DASHBOARD_FIXTURE });
    const has = (p: string): boolean => bundle.read("dashboard", p) !== undefined;
    expect(bundle.list("dashboard")).toContain("index.html");
    expect(bundle.list("dashboard")).toContain("task/index.html");
    expect(resolveDashboardAsset("/", has)).toBe("index.html");
    expect(resolveDashboardAsset("/task/", has)).toBe("task/index.html");
    expect(resolveDashboardAsset("/runs/r1", has)).toBe("index.html");
    expect(resolveDashboardAsset("/_next/static/chunks/missing.js", has)).toBeNull();
    expect(text(bundle.read("dashboard", "index.html"))).toBe(
      readFileSync(join(DASHBOARD_FIXTURE, "index.html"), "utf8"),
    );
  });

  it("carries the compiled role contracts and manifest in each plugin namespace", () => {
    const bundle = createDiskAssetBundle(writePluginTrees(tempDir()));
    for (const ns of ["plugin:claude-code", "plugin:codex"] as const) {
      expect(bundle.list(ns)).toContain(ROLE_CONTRACTS_ASSET);
      expect(bundle.list(ns)).toContain(PLUGIN_MANIFEST_ASSET);
    }
    // what the daemon loads at startup (AD-14 rule 6)
    expect(core.compiledRoleContracts(bundle).length).toBeGreaterThan(10);
    expect(core.pluginManifest(bundle, "codex")?.contracts_version).toBe(CONTRACTS_VERSION);
  });

  it("refuses unsafe paths, symlinks and anything outside the namespace", () => {
    const root = tempDir();
    const outside = tempDir();
    writeFileSync(join(outside, "secret.txt"), "secret");
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "ok.txt"), "ok");
    symlinkSync(join(outside, "secret.txt"), join(root, "a", "link.txt"));
    symlinkSync(outside, join(root, "dir-link"));
    const bundle = createDiskAssetBundle({ dashboard: root });
    expect(text(bundle.read("dashboard", "a/ok.txt"))).toBe("ok");
    for (const bad of [
      "../x",
      "a/../a/ok.txt",
      "/etc/hosts",
      "a//ok.txt",
      "a\\ok.txt",
      "a/./ok.txt",
      "",
      "a/link.txt",
      "dir-link/secret.txt",
    ])
      expect(bundle.read("dashboard", bad), bad).toBeUndefined();
    expect(bundle.list("dashboard")).toEqual(["a/ok.txt"]);
    expect(bundle.list("plugin:codex")).toEqual([]);
    expect(createDiskAssetBundle({ dashboard: join(root, "missing") }).list("dashboard")).toEqual(
      [],
    );
  });
});

describe("the embedded bundle (binary)", () => {
  const files = {
    dashboard: {
      "index.html": "/$bunfs/root/index-1.html",
      "task/index.html": "/$bunfs/root/t.html",
    },
  };
  const read = (p: string): Uint8Array => new TextEncoder().encode(`bytes of ${p}`);

  it("reads embedded files by asset path and lists them sorted", () => {
    const bundle = createEmbeddedAssetBundle(files, read);
    expect(text(bundle.read("dashboard", "task/index.html"))).toBe("bytes of /$bunfs/root/t.html");
    expect(bundle.list("dashboard")).toEqual(["index.html", "task/index.html"]);
    expect(bundle.list("plugin:codex")).toEqual([]);
    expect(bundle.read("dashboard", "missing")).toBeUndefined();
    expect(bundle.read("dashboard", "constructor")).toBeUndefined();
    expect(bundle.read("plugin:codex", "index.html")).toBeUndefined();
  });

  it("extracts a plugin namespace for install, replacing an older copy (AD-20 rule 5)", () => {
    const home = tempDir();
    const roots = writePluginTrees(tempDir());
    const disk = createDiskAssetBundle(roots);
    const runtime = binaryRuntime(disk, "/usr/local/bin/vtc");
    expect(runtime.selfCommand).toEqual(["/usr/local/bin/vtc"]);
    const stale = join(home, extractedPluginDir(VERSION, "codex"), "stale.txt");
    mkdirSync(join(stale, ".."), { recursive: true });
    writeFileSync(stale, "old");
    const dir = runtime.pluginDir("codex", home);
    expect(dir).toBe(join(home, extractedPluginDir(VERSION, "codex")));
    expect(existsSync(stale)).toBe(false);
    for (const path of disk.list("plugin:codex"))
      expect(readFileSync(join(dir, path), "utf8")).toBe(text(disk.read("plugin:codex", path)));
    expect(() =>
      extractNamespace(createEmbeddedAssetBundle({}), "plugin:codex", join(home, "x")),
    ).toThrow(/no plugin:codex assets/);
  });

  it("leaves an identical extracted plugin in place, so a running host never loses it", () => {
    const home = tempDir();
    const disk = createDiskAssetBundle(writePluginTrees(tempDir()));
    const dest = join(home, "plugin");
    extractNamespace(disk, "plugin:codex", dest);
    const before = statSync(dest).ino;
    expect(extractNamespace(disk, "plugin:codex", dest)).toBe(dest);
    expect(statSync(dest).ino).toBe(before);
    expect(readdirSync(home)).toEqual(["plugin"]);
    // a changed or extra file is replaced by the bundle's tree
    const [first = ""] = disk.list("plugin:codex");
    writeFileSync(join(dest, first), "tampered");
    writeFileSync(join(dest, "extra.txt"), "x");
    extractNamespace(disk, "plugin:codex", dest);
    expect(statSync(dest).ino).not.toBe(before);
    expect(readFileSync(join(dest, first), "utf8")).toBe(text(disk.read("plugin:codex", first)));
    expect(existsSync(join(dest, "extra.txt"))).toBe(false);
  });
});
