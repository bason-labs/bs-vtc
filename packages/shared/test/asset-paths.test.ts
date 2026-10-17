/** AD-20: how the engine serves the dashboard's static export, checked against a seeded export. */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ASSET_SOURCES,
  dashboardAssetHeaders,
  extractedPluginDir,
  resolveDashboardAsset,
} from "../src/index.js";

const root = fileURLToPath(new URL("../../../fixtures/dashboard-export/", import.meta.url));
const walk = (dir: string, prefix = ""): string[] =>
  readdirSync(dir).flatMap((name) =>
    statSync(join(dir, name)).isDirectory()
      ? walk(join(dir, name), `${prefix}${name}/`)
      : [`${prefix}${name}`],
  );
const files = new Set(walk(root).filter((f) => f !== "README.md"));
const resolve = (url: string): string | null => resolveDashboardAsset(url, (p) => files.has(p));

describe("resolveDashboardAsset (the seeded export in fixtures/dashboard-export)", () => {
  it.each([
    ["/", "index.html"],
    ["/index.html", "index.html"],
    ["/task/", "task/index.html"],
    ["/task", "task/index.html"],
    ["/icon.svg", "icon.svg"],
    ["/_next/static/chunks/app-3f9a.js", "_next/static/chunks/app-3f9a.js"],
    ["/runs/golden-1/tasks/T-2", "index.html"],
    ["/settings", "index.html"],
  ])("%s → %s", (url, file) => {
    expect(resolve(url)).toBe(file);
  });
  it.each([
    "/api",
    "/api/status",
    "/api/runs/golden-1/events",
    "/_next/static/chunks/missing.js",
    "/missing.png",
    "/../packages/shared/package.json",
    "/task/../index.html",
    "/%2e%2e/secret",
    "/a//b",
    "/a\\b",
    "/%00",
    "/%E0%A4%A",
    "relative",
  ])("refuses %s", (url) => {
    expect(resolve(url)).toBeNull();
  });
  it("has no SPA fallback when the export has no index.html", () => {
    expect(resolveDashboardAsset("/settings", () => false)).toBeNull();
  });
});

describe("dashboardAssetHeaders", () => {
  it("sets the content type by extension and never lets the browser sniff", () => {
    expect(dashboardAssetHeaders("index.html")).toEqual({
      "content-type": "text/html; charset=utf-8",
      "x-content-type-options": "nosniff",
      "cache-control": "no-cache",
    });
    expect(dashboardAssetHeaders("icon.svg")["content-type"]).toBe("image/svg+xml");
    expect(dashboardAssetHeaders("data.bin")["content-type"]).toBe("application/octet-stream");
    expect(dashboardAssetHeaders("LICENSE")["content-type"]).toBe("application/octet-stream");
  });
  it("caches only Next's content-hashed files forever", () => {
    const hashed = dashboardAssetHeaders("_next/static/chunks/app-3f9a.js");
    expect(hashed["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(hashed["cache-control"]).toBe("public, max-age=31536000, immutable");
  });
});

describe("asset sources and plugin extraction (AD-2 rule 7)", () => {
  it("names the build outputs the cli's AssetBundle reads", () => {
    expect(ASSET_SOURCES).toEqual({
      dashboard: "apps/dashboard/out",
      "plugin:claude-code": "dist/claude-plugin",
      "plugin:codex": "dist/codex-plugin",
    });
  });
  it("extracts a plugin per vtc version and host under the VTC home", () => {
    expect(extractedPluginDir("1.2.3", "codex")).toBe("plugins/1.2.3/codex");
    expect(extractedPluginDir("1.2.3-rc.1", "claude-code")).toBe("plugins/1.2.3-rc.1/claude-code");
    expect(() => extractedPluginDir("../x", "codex")).toThrow();
    expect(() => extractedPluginDir("1.2.3", "cursor" as never)).toThrow();
  });
});
