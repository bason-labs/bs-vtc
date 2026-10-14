/**
 * `vtc doctor` since wave 3: `--install-browser` and the browser pin (AD-24, D-ay; fakes only,
 * no test downloads a browser), Claude Code's minimum version for headless runs (AD-25), each
 * adapter's auth status, and the merge level with the Level-3 preflight (AD-23 rule 1).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BROWSER_PIN_FILE,
  BrowserPinSchema,
  MERGE_LEVEL_LEDGER,
  type HostAuthStatus,
  type RemoteMergePolicy,
} from "@vtc/shared";
import {
  BROWSER_PACKAGES,
  checkBrowser,
  findExecutable,
  installBrowser,
  installerEnv,
  matchesIntegrity,
  sha256OfFile,
  tarballUrl,
  tarExtract,
  type BrowserInstallDeps,
  type PinnedPackage,
} from "../src/browser-install.js";
import { createDoctorCommand, defaultDoctorEnv, engineBaseBranch } from "../src/commands/doctor.js";
import {
  CLAUDE_MIN_VERSION,
  checkHostAuth,
  checkMergeLevel,
  parseVersion,
  withClaudeMinimum,
  type MergeLevelEnv,
} from "../src/doctor-checks.js";
import { readCappedBody } from "../src/http-client.js";
import type { Exec, ExecResult } from "../src/process.js";
import { capture, cleanupDirs, initRepo, initVtcRepo, tempDir, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const integrityOf = (bytes: Uint8Array): string =>
  `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

/** An npm-style tarball (`package/…`) of `files`. */
const tarball = (files: Record<string, string>): Uint8Array => {
  const root = tempDir("vtc-pkg-");
  for (const [rel, text] of Object.entries(files)) {
    const path = join(root, "package", rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  const out = join(root, "pkg.tgz");
  expect(spawnSync("tar", ["-czf", out, "-C", root, "package"]).status).toBe(0);
  return new Uint8Array(readFileSync(out));
};

const REVISION = "1190";

const fakeRegistry = () => {
  const bodies = new Map<string, Uint8Array>();
  const packages: PinnedPackage[] = [];
  const add = (name: string, version: string, extra: Record<string, string> = {}): void => {
    const bytes = tarball({ "package.json": JSON.stringify({ name, version }), ...extra });
    bodies.set(tarballUrl({ name, version }), bytes);
    packages.push({ name, version, integrity: integrityOf(bytes) });
  };
  add("playwright-core", "1.63.0", {
    "cli.js": "// the installer\n",
    "browsers.json": JSON.stringify({
      browsers: [
        { name: "chromium", revision: "1189", browserVersion: "142.0.1" },
        { name: "chromium-headless-shell", revision: REVISION, browserVersion: "142.0.1" },
      ],
    }),
  });
  add("axe-core", "4.13.0", { "axe.min.js": "/* axe */\n" });
  return { bodies, packages };
};

const fakeDeps = (
  bodies: Map<string, Uint8Array>,
  over: Partial<BrowserInstallDeps> = {},
): BrowserInstallDeps & { downloads: string[]; installs: [string, string][]; lines: string[] } => {
  const downloads: string[] = [];
  const installs: [string, string][] = [];
  const lines: string[] = [];
  return {
    downloads,
    installs,
    lines,
    download: (url) => {
      downloads.push(url);
      const body = bodies.get(url);
      return body === undefined ? Promise.reject(new Error(`404 ${url}`)) : Promise.resolve(body);
    },
    extract: tarExtract,
    runInstaller: (cliJs, browsersPath) => {
      installs.push([cliJs, browsersPath]);
      const exe = join(
        browsersPath,
        `chromium_headless_shell-${REVISION}`,
        "chrome-headless-shell-mac-arm64",
        "chrome-headless-shell",
      );
      mkdirSync(dirname(exe), { recursive: true });
      writeFileSync(exe, "#!/bin/sh\necho headless\n");
      chmodSync(exe, 0o755);
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    },
    now: () => new Date("2026-10-14T10:00:00.000Z"),
    log: (line) => lines.push(line),
    ...over,
  };
};

describe("vtc doctor --install-browser (AD-24, D-ay)", () => {
  it("pins real npm packages by version and integrity", () => {
    expect(BROWSER_PACKAGES.map((p) => p.name)).toEqual([
      "playwright-core",
      "axe-core",
      "pixelmatch",
      "pngjs",
    ]);
    for (const p of BROWSER_PACKAGES) {
      expect(p.integrity).toMatch(/^sha512-[A-Za-z0-9+/]{86}==$/);
      expect(tarballUrl(p)).toBe(
        `https://registry.npmjs.org/${p.name}/-/${p.name}-${p.version}.tgz`,
      );
    }
    const bytes = new TextEncoder().encode("x");
    expect(matchesIntegrity(bytes, integrityOf(bytes))).toBe(true);
    expect(matchesIntegrity(bytes, integrityOf(new TextEncoder().encode("y")))).toBe(false);
    expect(matchesIntegrity(bytes, "sha1-abc")).toBe(false);
  });

  it("verifies each package, runs playwright-core's installer into the store and writes the pin", async () => {
    const home = tempHome();
    const { bodies, packages } = fakeRegistry();
    const deps = fakeDeps(bodies);
    const pin = await installBrowser(home, deps, packages);
    const store = join(home, "browsers");
    expect(readdirSync(join(store, "node_modules")).sort()).toEqual([
      "axe-core",
      "playwright-core",
    ]);
    expect(deps.installs).toEqual([[join(store, "node_modules/playwright-core/cli.js"), store]]);
    const exe = join(
      store,
      `chromium_headless_shell-${REVISION}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    );
    expect(pin).toEqual({
      v: 1,
      source: "vtc",
      name: "chromium-headless-shell",
      version: "142.0.1",
      playwright_core_version: "1.63.0",
      package_integrity: packages[0]?.integrity,
      executable: exe,
      executable_sha256: await sha256OfFile(exe),
      installed_at: "2026-10-14T10:00:00.000Z",
    });
    expect(
      BrowserPinSchema.parse(JSON.parse(readFileSync(join(home, BROWSER_PIN_FILE), "utf8"))),
    ).toEqual(pin);
    // no staging leftovers; a second run downloads nothing it already verified
    expect(readdirSync(store).filter((n) => n.startsWith(".staging"))).toEqual([]);
    const again = fakeDeps(bodies);
    await installBrowser(home, again, packages);
    expect(again.downloads).toEqual([]);
    expect(again.lines.join("\n")).toMatch(/already installed and verified/);
    // a package changed in the store after its install is noticed and installed again
    const cli = join(store, "node_modules/playwright-core/cli.js");
    const original = readFileSync(cli, "utf8");
    writeFileSync(cli, "tampered()");
    const third = fakeDeps(bodies);
    await installBrowser(home, third, packages);
    expect(third.downloads).toEqual([tarballUrl({ name: "playwright-core", version: "1.63.0" })]);
    expect(third.lines.join("\n")).toMatch(/changed since it was installed/);
    expect(readFileSync(cli, "utf8")).toBe(original);
  });

  it("says Node.js is needed when no node runs the installer", async () => {
    const home = tempHome();
    const { bodies, packages } = fakeRegistry();
    const deps = fakeDeps(bodies, {
      runInstaller: () => Promise.resolve({ code: null, stdout: "", stderr: "", error: "ENOENT" }),
    });
    await expect(installBrowser(home, deps, packages)).rejects.toThrow(
      /runs on Node\.js, and no node is on PATH/,
    );
  });

  it("runs the installer with an allowlisted environment: no credentials, no download host", () => {
    expect(
      installerEnv(
        {
          PATH: "/usr/bin",
          HOME: "/home/u",
          HTTPS_PROXY: "http://proxy:3128",
          GH_TOKEN: "x",
          AWS_SECRET_ACCESS_KEY: "y",
          ANTHROPIC_API_KEY: "z",
          PLAYWRIGHT_DOWNLOAD_HOST: "https://evil.example",
          PLAYWRIGHT_BROWSERS_PATH: "/elsewhere",
        },
        "/home/u/.vtc/browsers",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/u",
      HTTPS_PROXY: "http://proxy:3128",
      PLAYWRIGHT_BROWSERS_PATH: "/home/u/.vtc/browsers",
    });
  });

  it("caps a download while it streams, not after buffering it", async () => {
    const big = (): Error => new Error("larger than 1000 bytes");
    const chunk = new Uint8Array(400);
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull: (controller) => {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    await expect(readCappedBody(new Response(endless), 1_000, big)).rejects.toThrow(
      /larger than 1000 bytes/,
    );
    expect(pulled).toBeLessThan(10);
    await expect(
      readCappedBody(new Response("abc", { headers: { "content-length": "5000" } }), 1_000, big),
    ).rejects.toThrow(/larger than 1000 bytes/);
    expect(new TextDecoder().decode(await readCappedBody(new Response("abc"), 1_000, big))).toBe(
      "abc",
    );
  });

  it("installs nothing from a download that does not match its integrity", async () => {
    const home = tempHome();
    const { bodies, packages } = fakeRegistry();
    const url = tarballUrl({ name: "playwright-core", version: "1.63.0" });
    bodies.set(
      url,
      tarball({
        "package.json": JSON.stringify({ name: "playwright-core", version: "1.63.0" }),
        "cli.js": "evil()",
      }),
    );
    const deps = fakeDeps(bodies);
    await expect(installBrowser(home, deps, packages)).rejects.toThrow(
      /does not match its pinned integrity/,
    );
    expect(existsSync(join(home, "browsers/node_modules/playwright-core"))).toBe(false);
    expect(deps.installs).toEqual([]);
    expect(existsSync(join(home, BROWSER_PIN_FILE))).toBe(false);
  });

  it("refuses a tarball that unpacks to another package, and reports an installer failure", async () => {
    const home = tempHome();
    const wrong = tarball({
      "package.json": JSON.stringify({ name: "left-pad", version: "1.0.0" }),
    });
    const url = tarballUrl({ name: "axe-core", version: "4.13.0" });
    await expect(
      installBrowser(home, fakeDeps(new Map()), [
        { name: "axe-core", version: "4.13.0", integrity: integrityOf(wrong) },
      ]),
    ).rejects.toThrow(/needs playwright-core/);
    const { bodies, packages } = fakeRegistry();
    bodies.set(url, wrong);
    const mixed = packages.map((p) =>
      p.name === "axe-core" ? { ...p, integrity: integrityOf(wrong) } : p,
    );
    await expect(installBrowser(home, fakeDeps(bodies), mixed)).rejects.toThrow(
      /unpacked to something other than axe-core@4\.13\.0/,
    );
    const fresh = fakeRegistry();
    const failing = fakeDeps(fresh.bodies, {
      runInstaller: () =>
        Promise.resolve({ code: 1, stdout: "", stderr: "Host system is missing dependencies" }),
    });
    await expect(installBrowser(tempHome(), failing, fresh.packages)).rejects.toThrow(
      /installer failed: Host system is missing/,
    );
  });

  it("finds the headless shell's executable a few levels down", () => {
    const dir = tempDir();
    expect(findExecutable(dir)).toBeNull();
    const exe = join(dir, "chrome-linux", "headless_shell");
    mkdirSync(dirname(exe), { recursive: true });
    writeFileSync(exe, "");
    expect(findExecutable(dir)).toBe(exe);
  });

  it("checks the pin: none warns, a match is ok, a changed or missing browser fails", async () => {
    const home = tempHome();
    const env = { vtcHome: home, sha256: sha256OfFile };
    expect(await checkBrowser(env)).toMatchObject({
      name: "browser",
      status: "warn",
      detail: expect.stringMatching(
        /project's own Playwright.*vtc doctor --install-browser/,
      ) as string,
    });
    const { bodies, packages } = fakeRegistry();
    const pin = await installBrowser(home, fakeDeps(bodies), packages);
    expect(await checkBrowser(env)).toMatchObject({
      status: "ok",
      detail: expect.stringMatching(
        /chromium-headless-shell 142\.0\.1 \(playwright-core 1\.63\.0\), matches its pin/,
      ) as string,
    });
    writeFileSync(pin.executable, "tampered");
    expect(await checkBrowser(env)).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/no longer matches its pin/) as string,
    });
    expect(
      await checkBrowser({ vtcHome: home, sha256: () => Promise.reject(new Error("ENOENT")) }),
    ).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/is missing/) as string,
    });
    writeFileSync(join(home, BROWSER_PIN_FILE), "{");
    expect(await checkBrowser(env)).toMatchObject({
      status: "fail",
      detail: expect.stringMatching(/does not parse/) as string,
    });
  });

  it("installs only on the explicit flag, then reports the checks", async () => {
    const quiet: Exec = () =>
      Promise.resolve({ code: 0, stdout: "", stderr: "" } satisfies ExecResult);
    let installs = 0;
    const doctor = (fail = false) =>
      createDoctorCommand(() => ({
        exec: quiet,
        versions: { node: "22.17.1" },
        installBrowser: (log) => {
          installs += 1;
          log("  installing");
          return fail ? Promise.reject(new Error("offline")) : Promise.resolve();
        },
      }));
    const plain = capture("/w", "/h");
    expect(await doctor().run([], plain.ctx)).toBe(0);
    expect(installs).toBe(0);
    const flagged = capture("/w", "/h");
    expect(await doctor().run(["--install-browser"], flagged.ctx)).toBe(0);
    expect(installs).toBe(1);
    expect(flagged.out[0]).toBe("  installing");
    const failed = capture("/w", "/h");
    expect(await doctor(true).run(["--install-browser"], failed.ctx)).toBe(1);
    expect(failed.err.join("\n")).toMatch(/the browser was not installed: offline/);
  });
});

describe("vtc doctor: host versions and auth (AD-25)", () => {
  it("warns below Claude Code's minimum version for headless runs", async () => {
    expect(CLAUDE_MIN_VERSION).toBe("2.1.259");
    expect(parseVersion("2.1.259 (Claude Code)")).toEqual([2, 1, 259]);
    const ok = { name: "claude-code", status: "ok" as const, detail: "x, logged in" };
    expect(withClaudeMinimum(ok, "2.1.258 (Claude Code)")).toMatchObject({
      status: "warn",
      detail:
        "x, logged in; headless Claude runs need Claude Code 2.1.259 or later (--permission-prompts): run claude update",
    });
    expect(withClaudeMinimum(ok, "2.1.259 (Claude Code)")).toBe(ok);
    expect(withClaudeMinimum(ok, "3.0.0")).toBe(ok);
    expect(withClaudeMinimum(ok, "claude")).toBe(ok);
    const failing = { ...ok, status: "fail" as const };
    expect(withClaudeMinimum(failing, "1.0.0")).toBe(failing);
    const exec: Exec = (command, args) =>
      Promise.resolve({
        code: 0,
        stderr: "",
        stdout:
          `${command} ${args.join(" ")}` === "claude --version"
            ? "2.0.10 (Claude Code)\n"
            : `${command} ${args.join(" ")}` === "claude auth status --json"
              ? JSON.stringify({ loggedIn: true })
              : "",
      });
    const { ctx, out } = capture("/w", "/h");
    expect(
      await createDoctorCommand(() => ({ exec, versions: { node: "22.17.1" } })).run([], ctx),
    ).toBe(0);
    expect(out.join("\n")).toMatch(
      /warn +claude-code +2\.0\.10 \(Claude Code\), logged in; headless Claude runs need/,
    );
  });

  it("reports each adapter's auth status, the check the engine runs before unattended runs", async () => {
    const at = "2026-10-14T10:00:00.000Z";
    const s = (
      host: HostAuthStatus["host"],
      logged_in: boolean | null,
      method: string | null = null,
    ): HostAuthStatus => ({
      host,
      logged_in,
      method,
      checked_at: at,
    });
    expect(checkHostAuth([])).toBeNull();
    expect(checkHostAuth([s("claude-code", true, "claude.ai"), s("codex", false)])).toEqual({
      name: "host auth",
      status: "ok",
      detail: "claude-code logged in (claude.ai); codex not logged in",
    });
    expect(checkHostAuth([s("codex", null)])).toEqual({
      name: "host auth",
      status: "warn",
      detail:
        "codex unknown (its status command did not run): an unattended run parks with auth until you log in",
    });
    const { ctx, out } = capture("/w", "/h");
    const quiet: Exec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });
    await createDoctorCommand(() => ({
      exec: quiet,
      versions: { node: "22.17.1" },
      hostAuth: () => Promise.resolve([s("codex", true, "ChatGPT")]),
    })).run([], ctx);
    expect(out.join("\n")).toMatch(/ok +host auth +codex logged in \(ChatGPT\)/);
  });
});

const POLICY: RemoteMergePolicy = {
  base: "main",
  auto_merge_allowed: true,
  required_checks: ["test"],
  merge_methods: ["squash"],
  merge_queue: false,
  requires_review: false,
  signatures_required: false,
};

const levelEnv = (over: Partial<MergeLevelEnv> = {}): MergeLevelEnv => ({
  configured: 3,
  ledger: [],
  base: "main",
  remote: () => Promise.resolve({ github: true, ghAuthenticated: true }),
  policy: () => Promise.resolve(POLICY),
  ...over,
});

describe("vtc doctor: the merge level and the Level-3 preflight (AD-23 rule 1)", () => {
  it("checks the branch the engine targets: the current one, else main", () => {
    expect(engineBaseBranch("develop\n")).toBe("develop");
    expect(engineBaseBranch("release/2.0")).toBe("release/2.0");
    expect(engineBaseBranch("HEAD\n")).toBe("main");
    expect(engineBaseBranch("vtc/F-1")).toBe("main");
    expect(engineBaseBranch("")).toBe("main");
  });

  it("passes Level 3 only when GitHub enforces what the checklist promises", async () => {
    expect(await checkMergeLevel(levelEnv())).toEqual({
      name: "merge level",
      status: "ok",
      detail: "level 3 preflight passes on main (required checks: test)",
    });
    expect(
      (
        await checkMergeLevel(
          levelEnv({
            policy: () =>
              Promise.resolve({
                ...POLICY,
                required_checks: [],
                auto_merge_allowed: false,
                merge_methods: [],
              }),
          }),
        )
      ).detail,
    ).toBe(
      "project.yaml asks for level 3, but runs start at level 2: allow auto-merge in the repository settings; add at least one required status check on main (a ruleset or branch protection), or GitHub would merge without CI; allow at least one merge method (or your access cannot read the repository settings)",
    );
    expect(
      await checkMergeLevel(
        levelEnv({ remote: () => Promise.resolve({ github: false, ghAuthenticated: false }) }),
      ),
    ).toMatchObject({
      status: "warn",
      detail: expect.stringMatching(/not on GitHub \(Level 3 is GitHub-only\)/) as string,
    });
    expect(
      (
        await checkMergeLevel(
          levelEnv({ remote: () => Promise.resolve({ github: true, ghAuthenticated: false }) }),
        )
      ).detail,
    ).toMatch(/gh auth login/);
    // a policy gh cannot read fails closed
    expect(
      (await checkMergeLevel(levelEnv({ policy: () => Promise.reject(new Error("HTTP 403")) })))
        .detail,
    ).toMatch(/required status check/);
  });

  it("shows a ledger downgrade and skips the preflight below Level 3", async () => {
    let asked = 0;
    const counting = levelEnv({
      configured: 2,
      remote: () => {
        asked += 1;
        return Promise.resolve({ github: true, ghAuthenticated: true });
      },
    });
    expect(await checkMergeLevel(counting)).toEqual({
      name: "merge level",
      status: "ok",
      detail: "level 2",
    });
    expect(asked).toBe(0);
    expect(await checkMergeLevel(levelEnv({ ledger: [{ kind: "downgrade", cap: 2 }] }))).toEqual({
      name: "merge level",
      status: "warn",
      detail:
        "level 3 preflight passes on main (required checks: test); the ledger caps it at 2 after a downgrade (vtc merge-level restore)",
    });
  });

  it("reads project.yaml and the ledger of the VTC repo doctor runs in", async () => {
    const repo = initVtcRepo();
    writeFileSync(
      join(repo, MERGE_LEVEL_LEDGER),
      `${JSON.stringify({ v: 1, at: "2026-10-13T09:00:00.000Z", kind: "downgrade", cap: 1, reason: "revert", detail: "reverted" })}\n`,
    );
    const env = await defaultDoctorEnv(capture(repo, tempHome()).ctx).mergeLevel?.();
    expect(env).toMatchObject({
      configured: 2,
      ledger: [{ kind: "downgrade", cap: 1 }],
      base: "main",
    });
    expect(await defaultDoctorEnv(capture(initRepo(), tempHome()).ctx).mergeLevel?.()).toBeNull();
    expect(await defaultDoctorEnv(capture(tempDir(), tempHome()).ctx).mergeLevel?.()).toBeNull();
  });
});
