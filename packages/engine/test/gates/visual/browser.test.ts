import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BROWSER_PIN_FILE } from "@vtc/shared";
import {
  checkProjectBrowser,
  checkStoreBrowser,
  chromiumOf,
  projectBrowsersPath,
  projectPinPath,
  projectToolchain,
  storeToolchain,
} from "../../../src/gates/visual/browser.js";
import type { BrowserCheck } from "../../../src/gates/visual/browser.js";
import { tempDir } from "../../helpers/repo.js";

const reasonOf = (check: BrowserCheck | null): string =>
  check !== null && !check.ok ? check.reason : "(no failure)";

const pkg = (
  dir: string,
  name: string,
  extra: Record<string, unknown> = {},
  files: Record<string, string> = {},
): void => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", ...extra }));
  for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
};

describe("toolchain resolution", () => {
  it("finds the project's playwright-core, axe-core and pixelmatch inside the checkout", () => {
    const checkout = tempDir("vtc-checkout-");
    pkg(
      join(checkout, "node_modules/playwright-core"),
      "playwright-core",
      { main: "index.js", version: "1.60.0" },
      {
        "index.js": "module.exports = {};",
        "browsers.json": JSON.stringify({
          browsers: [{ name: "chromium", revision: "1200", browserVersion: "140.0.7339.16" }],
        }),
      },
    );
    pkg(join(checkout, "node_modules/axe-core"), "axe-core", {}, { "axe.min.js": "/* axe */" });
    pkg(
      join(checkout, "node_modules/pixelmatch"),
      "pixelmatch",
      { type: "module", exports: "./index.js" },
      {
        "index.js": "export default () => 0;",
      },
    );
    const tc = projectToolchain(checkout, { PLAYWRIGHT_BROWSERS_PATH: "/opt/pw" });
    const real = realpathSync(checkout);
    expect(tc).toEqual({
      source: "project",
      playwright: join(real, "node_modules/playwright-core/index.js"),
      playwrightVersion: "1.60.0",
      axe: join(real, "node_modules/axe-core/axe.min.js"),
      pixelmatch: join(real, "node_modules/pixelmatch/index.js"),
      browsersPath: "/opt/pw",
      readable: ["/opt/pw"],
    });
    expect(chromiumOf(tc?.playwright ?? "")).toEqual({
      name: "chromium",
      version: "140.0.7339.16",
    });
  });

  it("follows a pnpm layout through playwright to its playwright-core", () => {
    const checkout = tempDir("vtc-checkout-");
    const store = join(checkout, "node_modules/.pnpm/playwright@1.60.0/node_modules");
    pkg(join(store, "playwright"), "playwright", { main: "index.js" }, { "index.js": "" });
    pkg(
      join(store, "playwright-core"),
      "playwright-core",
      { main: "index.js" },
      { "index.js": "" },
    );
    symlinkSync(join(store, "playwright"), join(checkout, "node_modules/playwright"));
    const tc = projectToolchain(checkout, {});
    expect(tc?.playwright).toBe(join(realpathSync(store), "playwright-core/index.js"));
    expect(tc?.axe).toBeNull();
    expect(tc?.pixelmatch).toBeNull();
  });

  it("never resolves a package that lives outside the checkout", () => {
    const outside = tempDir("vtc-outside-");
    pkg(
      join(outside, "playwright-core"),
      "playwright-core",
      { main: "index.js" },
      { "index.js": "" },
    );
    const checkout = tempDir("vtc-checkout-");
    mkdirSync(join(checkout, "node_modules"));
    symlinkSync(join(outside, "playwright-core"), join(checkout, "node_modules/playwright-core"));
    expect(projectToolchain(checkout, {})).toBeNull();
    expect(projectToolchain(tempDir("vtc-empty-"), {})).toBeNull();
  });

  it("finds the doctor-installed store under the VTC home", () => {
    const home = tempDir("vtc-home-");
    expect(storeToolchain(home)).toBeNull();
    pkg(
      join(home, "browsers/node_modules/playwright-core"),
      "playwright-core",
      { main: "index.js" },
      { "index.js": "" },
    );
    const tc = storeToolchain(home);
    expect(tc?.source).toBe("vtc");
    expect(tc?.browsersPath).toBe(join(home, "browsers"));
  });

  it("knows each platform's Playwright cache", () => {
    expect(projectBrowsersPath({}, "darwin", "/Users/a")).toBe(
      "/Users/a/Library/Caches/ms-playwright",
    );
    expect(projectBrowsersPath({}, "linux", "/home/a")).toBe("/home/a/.cache/ms-playwright");
    expect(projectBrowsersPath({ XDG_CACHE_HOME: "/xdg" }, "linux", "/home/a")).toBe(
      "/xdg/ms-playwright",
    );
    expect(projectBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: "relative" }, "linux", "/home/a")).toBe(
      "/home/a/.cache/ms-playwright",
    );
  });
});

describe("browser pins", () => {
  const exeIn = (dir: string, content = "binary"): { exe: string; sha: string } => {
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "chrome");
    writeFileSync(exe, content);
    return { exe: realpathSync(exe), sha: createHash("sha256").update(content).digest("hex") };
  };
  const now = new Date("2026-10-14T08:00:00.000Z");

  it("pins the project's browser on first use, then re-verifies it", async () => {
    const home = tempDir("vtc-home-");
    const cache = tempDir("vtc-cache-");
    const { exe, sha } = exeIn(join(cache, "chromium-1200"));
    const options = {
      vtcHome: home,
      repoRoot: "/repo",
      executable: exe,
      browsersPath: cache,
      name: "chromium",
      version: "140",
      playwrightVersion: "1.60.0",
      now,
    };
    const first = await checkProjectBrowser(options);
    expect(first?.ok === true ? first.note : "").toMatch(/first use/);
    const pin = JSON.parse(readFileSync(projectPinPath(home, "/repo"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(pin).toMatchObject({ source: "project", executable: exe, executable_sha256: sha });
    expect(await checkProjectBrowser(options)).toMatchObject({ ok: true });
    writeFileSync(exe, "tampered");
    expect(reasonOf(await checkProjectBrowser(options))).toMatch(/does not match its pin/);
  });

  it("ignores an executable outside the browsers path", async () => {
    const outside = exeIn(tempDir("vtc-elsewhere-"));
    expect(
      await checkProjectBrowser({
        vtcHome: tempDir("vtc-home-"),
        repoRoot: "/repo",
        executable: outside.exe,
        browsersPath: tempDir("vtc-cache-"),
        name: "chromium",
        version: "140",
        playwrightVersion: "1.60.0",
        now,
      }),
    ).toBeNull();
  });

  it("verifies the doctor-installed pin and refuses one outside the store", async () => {
    const home = tempDir("vtc-home-");
    expect(await checkStoreBrowser(home)).toBeNull();
    const { exe, sha } = exeIn(join(home, "browsers/chromium"));
    const write = (pin: Record<string, unknown>): void => {
      writeFileSync(
        join(home, BROWSER_PIN_FILE),
        JSON.stringify({
          v: 1,
          source: "vtc",
          name: "chromium",
          version: "140",
          playwright_core_version: "1.60.0",
          executable: exe,
          executable_sha256: sha,
          installed_at: now.toISOString(),
          ...pin,
        }),
      );
    };
    write({});
    expect(await checkStoreBrowser(home)).toMatchObject({ ok: true });
    write({ executable_sha256: "f".repeat(64) });
    expect(await checkStoreBrowser(home)).toMatchObject({ ok: false });
    const elsewhere = exeIn(tempDir("vtc-elsewhere-"));
    write({ executable: elsewhere.exe, executable_sha256: elsewhere.sha });
    expect(reasonOf(await checkStoreBrowser(home))).toMatch(/outside/);
    writeFileSync(join(home, BROWSER_PIN_FILE), "{ not json");
    expect(reasonOf(await checkStoreBrowser(home))).toMatch(/unreadable/);
  });
});
