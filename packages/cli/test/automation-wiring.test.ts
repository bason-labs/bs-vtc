/**
 * The cli's half of automatic issues and PRs (spine AD-27 rule 7; readings 194, 196 and 201): the
 * user-level settings of `~/.vtc/config.yaml`, the evidence hosting the machine allows, the probe
 * behind it, and `EngineDeps.automation` / `EngineDeps.armPlugins` as `buildEngineParts` injects
 * them. Fakes only (D-cc): no test runs the real `gh`, `ffmpeg` or a host.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as compiler from "@vtc/compiler";
import { gates, git } from "@vtc/engine";
import {
  DEFAULT_UPSTREAM_REPO,
  type ArmPluginCompiler,
  type ArmPluginRequest,
  type EvidenceRecorder,
  type GitPlumbing,
} from "@vtc/shared";
import { createDiskAssetBundle } from "../src/assets.js";
import {
  armPluginCompiler,
  buildAutomationDeps,
  evidenceHostingFor,
  probeAutomation,
  requestedHostingOf,
  shippedArmPluginCompilerFactory,
  shippedAutomationFactories,
  upstreamSettingsOf,
  vtcAdvisoriesScan,
  type AutomationFactories,
  type AutomationProbe,
} from "../src/automation-wiring.js";
import type { Exec } from "../src/process.js";
import { readUserConfig, type UserConfigRead } from "../src/user-config.js";
import { buildEngineParts, composeEngineDeps } from "../src/wiring.js";
import { cleanupDirs, fakePullRequests, tempHome } from "./helpers.js";
import { ROUND4_LANDED } from "./round4-merge.js";

afterEach(cleanupDirs);

const read = (yaml: string): UserConfigRead => {
  const home = tempHome();
  writeFileSync(join(home, "config.yaml"), yaml);
  return readUserConfig(home);
};

const PROBE: AutomationProbe = {
  ghVersion: "gh version 2.101.0 (2026-09-15)",
  ghLoggedIn: null,
  githubRemote: true,
  ffmpeg: null,
};

describe("~/.vtc/config.yaml upstream and automation.evidence_hosting (D-bz, D-by, reading 196)", () => {
  it("defaults to bason-labs/bs-vtc with sharing on and no checkout", () => {
    expect(upstreamSettingsOf(read("version: 1\n"))).toEqual({
      repo: DEFAULT_UPSTREAM_REPO,
      share: true,
    });
    expect(requestedHostingOf(read("version: 1\n"))).toBe("branch");
  });

  it("takes the user's repo, share switch and absolute checkout", () => {
    const config = read(
      "version: 1\nupstream:\n  repo: me/vtc-fork\n  share: false\n  checkout: /src/bs-vtc\nautomation:\n  evidence_hosting: attach\n",
    );
    expect(upstreamSettingsOf(config)).toEqual({
      repo: "me/vtc-fork",
      share: false,
      checkout: "/src/bs-vtc",
    });
    expect(requestedHostingOf(config)).toBe("attach");
  });

  it("refuses a relative checkout, and a file that does not parse turns sharing off", () => {
    const relative = read("version: 1\nupstream:\n  checkout: src/bs-vtc\n");
    expect(relative.ok).toBe(false);
    // privacy fails closed: the user may have switched sharing off in the file that broke
    expect(upstreamSettingsOf(relative)).toEqual({ repo: DEFAULT_UPSTREAM_REPO, share: false });
    expect(requestedHostingOf(relative)).toBe("branch");
  });
});

describe("evidence hosting (reading 196): attach only with gh >= 2.99.0 and a github.com remote", () => {
  it("keeps branch, the default, whatever gh can do", () => {
    expect(evidenceHostingFor("branch", PROBE)).toEqual({ hosting: "branch" });
  });

  it("allows attach on gh 2.99.0 or later with a github.com remote", () => {
    expect(evidenceHostingFor("attach", PROBE)).toEqual({ hosting: "attach" });
    expect(
      evidenceHostingFor("attach", { ...PROBE, ghVersion: "gh version 2.99.0 (2026-09-01)" }),
    ).toEqual({ hosting: "attach" });
  });

  it("falls back to branch, saying why, on an older or missing gh or a remote off github.com", () => {
    expect(
      evidenceHostingFor("attach", { ...PROBE, ghVersion: "gh version 2.98.2 (2026-08-01)" }),
    ).toEqual({
      hosting: "branch",
      fallback: "gh version 2.98.2 is older than 2.99.0, the first with --attach",
    });
    expect(evidenceHostingFor("attach", { ...PROBE, ghVersion: null })).toEqual({
      hosting: "branch",
      fallback: "gh is not on PATH",
    });
    expect(evidenceHostingFor("attach", { ...PROBE, githubRemote: false })).toEqual({
      hosting: "branch",
      fallback: "the origin remote is not on github.com (gh --attach is github.com only)",
    });
  });
});

/** An `Exec` that answers from a table and records every call. */
const fakeExec = (
  answers: Readonly<Record<string, { code: number | null; stdout?: string }>>,
): Exec & { calls: { line: string; env?: Readonly<Record<string, string>>; cwd?: string }[] } => {
  const calls: { line: string; env?: Readonly<Record<string, string>>; cwd?: string }[] = [];
  const exec = ((command: string, args: readonly string[], options) => {
    const line = [command, ...args].join(" ");
    calls.push({
      line,
      ...(options?.env === undefined ? {} : { env: options.env }),
      ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    });
    const answer = answers[line] ?? { code: null };
    return Promise.resolve({ code: answer.code, stdout: answer.stdout ?? "", stderr: "" });
  }) as Exec & { calls: typeof calls };
  exec.calls = calls;
  return exec;
};

const MACHINE = {
  "gh --version": { code: 0, stdout: "gh version 2.101.0 (2026-09-15)\nhttps://x\n" },
  "gh auth status": { code: 0, stdout: "Logged in to github.com account someone" },
  "ffmpeg -version": { code: 0, stdout: "ffmpeg version 7.1 Copyright\n" },
  "git -C /r remote get-url --push origin": { code: 0, stdout: "git@github.com:o/r.git\n" },
};

describe("probeAutomation", () => {
  it("reads gh's version, the login by exit code only, ffmpeg and the origin remote", async () => {
    const exec = fakeExec(MACHINE);
    expect(await probeAutomation(exec, { repoRoot: "/r", login: true, cwd: "/h" })).toEqual({
      ghVersion: "gh version 2.101.0 (2026-09-15)",
      ghLoggedIn: true,
      githubRemote: true,
      ffmpeg: "ffmpeg version 7.1 Copyright",
    });
    const auth = exec.calls.find((c) => c.line.startsWith("gh auth"));
    // never --show-token, never a prompt; nothing gh prints is kept
    expect(auth).toEqual({ line: "gh auth status", env: { GH_PROMPT_DISABLED: "1" }, cwd: "/h" });
    // every command runs by name in the user's own directory, so a repo's ffmpeg.exe or git.exe
    // is never the one a bare name finds on Windows; git reaches the repo with -C
    for (const call of exec.calls) expect(call.cwd, call.line).toBe("/h");
    expect(exec.calls.map((c) => c.line)).toContain("git -C /r remote get-url --push origin");
  });

  it("does not ask gh for the login unless asked, and reports what is missing", async () => {
    const exec = fakeExec({
      "git -C /r remote get-url --push origin": {
        code: 0,
        stdout: "https://ghe.example.com/o/r.git",
      },
    });
    expect(await probeAutomation(exec, { repoRoot: "/r", login: false, cwd: "/h" })).toEqual({
      ghVersion: null,
      ghLoggedIn: null,
      githubRemote: false,
      ffmpeg: null,
    });
    expect(exec.calls.map((c) => c.line)).not.toContain("gh auth status");
    // outside a repo there is no remote to read
    const none = fakeExec(MACHINE);
    expect(
      (await probeAutomation(none, { repoRoot: null, login: true, cwd: "/h" })).githubRemote,
    ).toBe(false);
    expect(none.calls.some((c) => c.line.startsWith("git "))).toBe(false);
  });

  it("runs the configured gh command", async () => {
    const exec = fakeExec({ "/opt/gh --version": { code: 0, stdout: "gh version 2.99.1" } });
    const probe = await probeAutomation(exec, {
      repoRoot: null,
      login: false,
      cwd: "/h",
      gh: "/opt/gh",
    });
    expect(probe.ghVersion).toBe("gh version 2.99.1");
  });
});

const fakeRecorder: EvidenceRecorder = {
  capture: () => Promise.resolve({ files: [], failed: [] }),
  renderGateReport: () => Promise.resolve({ html: "report.html" }),
};

describe("EngineDeps.automation (AutomationDeps, AD-27 rule 7)", () => {
  it("carries the user's upstream settings, the allowed hosting, ffmpeg and the engine seams", () => {
    const plumbing = (): GitPlumbing => ({}) as GitPlumbing;
    let built = 0;
    const factories: AutomationFactories = {
      plumbing,
      evidence: () => (built++, fakeRecorder),
    };
    const deps = buildAutomationDeps({
      user: () => read("version: 1\nautomation:\n  evidence_hosting: attach\n"),
      probe: { ...PROBE, ffmpeg: "ffmpeg version 7.1" },
      factories,
      gateDeps: { repoRoot: "/r", vtcHome: "/h", allowUnsandboxed: false },
    });
    expect(deps.upstream).toEqual({ repo: DEFAULT_UPSTREAM_REPO, share: true });
    expect(deps.hosting).toBe("attach");
    expect(deps.ffmpeg).toBe(true);
    expect(deps.plumbing).toBe(plumbing);
    // the gh-backed issue and PR services are the upstream module's defaults
    expect(deps).not.toHaveProperty("issues");
    expect(deps).not.toHaveProperty("pullRequests");
    // the recorder is built on first use only
    expect(built).toBe(0);
    expect(deps.evidence).toBeDefined();
    return deps.evidence?.renderGateReport({ report: {} as never, outDir: "/o" }).then((r) => {
      expect(r).toEqual({ html: "report.html" });
      expect(built).toBe(1);
    });
  });

  it("leaves out what is not there: no recorder, no plumbing, branch hosting without gh", () => {
    const deps = buildAutomationDeps({
      user: () => read("version: 1\nautomation:\n  evidence_hosting: attach\n"),
      probe: { ...PROBE, ghVersion: null },
      factories: {},
      gateDeps: { repoRoot: "/r", vtcHome: "/h", allowUnsandboxed: false },
    });
    expect(deps).not.toHaveProperty("evidence");
    expect(deps).not.toHaveProperty("plumbing");
    expect(deps.hosting).toBe("branch");
    expect(deps.ffmpeg).toBe(false);
  });

  it("passes the gate runner's own deps to the recorder, which fails its calls if it cannot be built", async () => {
    const seen: unknown[] = [];
    const deps = buildAutomationDeps({
      user: () => read("version: 1\n"),
      probe: PROBE,
      factories: {
        evidence: (d) => {
          seen.push(d);
          throw new Error("no toolchain");
        },
      },
      gateDeps: { repoRoot: "/r", vtcHome: "/h", allowUnsandboxed: true },
    });
    await expect(
      deps.evidence?.capture({
        origin: "http://127.0.0.1:1",
        outDir: "/o",
        shots: [],
        redactSelectors: [],
        denyText: [],
      }),
    ).rejects.toThrow(/no toolchain/);
    expect(seen).toEqual([{ repoRoot: "/r", vtcHome: "/h", allowUnsandboxed: true }]);
  });
});

/** A `createArmPluginCompiler` that records the base plugin dir of each arm it compiles. */
const fakeArmCompiler =
  (calls: [ArmPluginRequest, string][]) =>
  (options: { readonly pluginDir: string }): ArmPluginCompiler => ({
    compileArm: (request) => {
      calls.push([request, options.pluginDir]);
      return Promise.resolve({
        dir: request.outDir,
        version: "arm-0123456789ab",
        promptSha256: "a".repeat(64),
      });
    },
  });

describe("AutomationDeps.vtcAdvisories (D-bv (4), reading 216): VTC's own lockfile, scanned offline", () => {
  const LOCK = new TextEncoder().encode("lockfileVersion: '9.0'\n");
  const scanners: gates.ScannerStore = {
    names: ["osv-scanner"],
    ensure: () => Promise.reject(new Error("no scanner in a test")),
  };

  it("hands the gates' offline scan this vtc's lockfile, and reads its advisories", async () => {
    const seen: gates.OsvScanRequest[] = [];
    const scan = vtcAdvisoriesScan({
      vtcHome: "/h",
      lockfile: () => LOCK,
      allowUnsandboxed: true,
      scanners,
      scan: (request) => {
        seen.push(request);
        return Promise.resolve({
          ok: true,
          advisories: [{ id: "GHSA-aaaa-bbbb-cccc", package: "vite" }],
        });
      },
    });
    expect(await scan()).toEqual([{ id: "GHSA-aaaa-bbbb-cccc", package: "vite" }]);
    expect(seen[0]).toMatchObject({
      vtcHome: "/h",
      lockfile: LOCK,
      scanners,
      allowUnsandboxed: true,
      logDir: join("/h", "logs", "osv-scan"),
    });
  });

  it("answers null without a lockfile or the offline database, and fails on a scan error", async () => {
    let calls = 0;
    const none = vtcAdvisoriesScan({
      vtcHome: "/h",
      lockfile: () => undefined,
      allowUnsandboxed: false,
      scanners,
      scan: () => {
        calls += 1;
        return Promise.resolve({ ok: true, advisories: [] });
      },
    });
    expect(await none()).toBeNull();
    expect(calls).toBe(0);
    const answer = (result: gates.OsvScanResult) =>
      vtcAdvisoriesScan({
        vtcHome: "/h",
        lockfile: () => LOCK,
        allowUnsandboxed: false,
        scanners,
        scan: () => Promise.resolve(result),
      })();
    expect(await answer({ ok: false, reason: "no_database", detail: "no db" })).toBeNull();
    await expect(answer({ ok: false, reason: "failed", detail: "exit code 2" })).rejects.toThrow(
      /exit code 2/,
    );
  });
});

describe("EngineDeps.armPlugins (D-cg, reading 201): the compiler's arm compiler over the shipped plugin", () => {
  it("compiles each arm from that host's plugin directory, resolved only when an arm is compiled", async () => {
    const dirs: string[] = [];
    const calls: [ArmPluginRequest, string][] = [];
    const armCompiler = armPluginCompiler(fakeArmCompiler(calls), (host) => {
      dirs.push(host);
      return `/plugins/${host}`;
    });
    expect(dirs).toEqual([]);
    const request: ArmPluginRequest = {
      host: "claude-code",
      agent: "vtc-engineer",
      editable: "Be brief.",
      outDir: "/h/guard/lookback/arms/t1/b",
    };
    expect(await armCompiler.compileArm(request)).toMatchObject({ dir: request.outDir });
    expect(calls).toEqual([[request, "/plugins/claude-code"]]);
  });
});

describe("buildEngineParts injects automation and arm plugins", () => {
  const base = {
    repoRoot: "/r",
    vtcHome: "/h",
    installToken: "k".repeat(43),
    assets: createDiskAssetBundle({}),
    pullRequests: fakePullRequests(),
    adapterFactories: {},
  };

  it("probes the machine with the injected exec (never the real gh in a test)", async () => {
    const home = tempHome();
    writeFileSync(join(home, "config.yaml"), "version: 1\nupstream:\n  share: false\n");
    const exec = fakeExec(MACHINE);
    const parts = await buildEngineParts({
      ...base,
      vtcHome: home,
      exec,
      automationFactories: {},
      createArmPluginCompiler: null,
    });
    const deps = composeEngineDeps(parts);
    expect(deps.automation).toEqual({
      upstream: { repo: DEFAULT_UPSTREAM_REPO, share: false },
      hosting: "branch",
      ffmpeg: true,
      ghLogin: expect.any(Function) as unknown,
      // D-bv (4): the daily offline scan of this vtc's own lockfile (reading 216)
      vtcAdvisories: expect.any(Function) as unknown,
    });
    // building asks for no login; the daemon asks through ghLogin when it starts (D-bz)
    expect(exec.calls.map((c) => c.line).sort()).toEqual([
      "ffmpeg -version",
      "gh --version",
      "git -C /r remote get-url --push origin",
    ]);
    expect(await deps.automation?.ghLogin?.()).toBe(true);
    // gh auth status's exit code only: never --show-token, never a prompt
    expect(exec.calls.at(-1)).toEqual({
      line: "gh auth status",
      env: { GH_PROMPT_DISABLED: "1" },
      cwd: home,
    });
    expect(deps).not.toHaveProperty("armPlugins");
  });

  it("reports gh as logged out when gh auth status fails, and without gh asks nothing", async () => {
    const home = tempHome();
    const loggedOut = fakeExec({ ...MACHINE, "gh auth status": { code: 1 } });
    const parts = await buildEngineParts({
      ...base,
      vtcHome: home,
      exec: loggedOut,
      automationFactories: {},
      createArmPluginCompiler: null,
    });
    expect(await composeEngineDeps(parts).automation?.ghLogin?.()).toBe(false);
    const noGh = fakeExec({ "ffmpeg -version": MACHINE["ffmpeg -version"] });
    const without = await buildEngineParts({
      ...base,
      vtcHome: home,
      exec: noGh,
      automationFactories: {},
      createArmPluginCompiler: null,
    });
    expect(await composeEngineDeps(without).automation?.ghLogin?.()).toBe(false);
    expect(noGh.calls.map((c) => c.line)).not.toContain("gh auth status");
  });

  it("injects none with automation: null, and arm plugins over the runtime's plugin dir", async () => {
    const calls: [ArmPluginRequest, string][] = [];
    const parts = await buildEngineParts({
      ...base,
      automation: null,
      pluginDir: (host, home) => `${home}/plugins/${host}`,
      createArmPluginCompiler: fakeArmCompiler(calls),
    });
    const deps = composeEngineDeps(parts);
    expect(deps).not.toHaveProperty("automation");
    await deps.armPlugins?.compileArm({
      host: "claude-code",
      agent: "vtc-engineer",
      editable: "",
      outDir: "/o",
    });
    expect(calls.map(([, dir]) => dir)).toEqual(["/h/plugins/claude-code"]);
  });

  it("reads ~/.vtc/config.yaml again at each use: an opt-out flipped while the daemon runs is seen (AD-27 rule 5)", async () => {
    const home = tempHome();
    const file = join(home, "config.yaml");
    writeFileSync(file, "version: 1\n");
    const parts = await buildEngineParts({
      ...base,
      vtcHome: home,
      exec: fakeExec(MACHINE),
      automationFactories: {},
      createArmPluginCompiler: null,
    });
    const automation = composeEngineDeps(parts).automation;
    expect(automation?.upstream.share).toBe(true);
    expect(automation?.hosting).toBe("branch");
    writeFileSync(
      file,
      "version: 1\nupstream:\n  repo: me/vtc-fork\n  share: false\n  checkout: /src/bs-vtc\nautomation:\n  evidence_hosting: attach\n",
    );
    expect(automation?.upstream.share).toBe(false);
    expect(automation?.upstream).toEqual({
      repo: "me/vtc-fork",
      share: false,
      checkout: "/src/bs-vtc",
    });
    // this machine (gh 2.101.0, a github.com origin) allows attach, probed once at start
    expect(automation?.hosting).toBe("attach");
    // a file that no longer parses keeps sharing off (privacy fails closed)
    writeFileSync(file, "version: 1\nupstream: [\n");
    expect(automation?.upstream.share).toBe(false);
    expect(automation?.upstream.repo).toBe(DEFAULT_UPSTREAM_REPO);
    writeFileSync(file, "version: 1\nupstream:\n  share: true\n");
    expect(automation?.upstream.share).toBe(true);
    expect(automation?.upstream.checkout).toBeUndefined();
  });
});

/** The names a namespace exports as functions that match `pattern`. */
const functionsNamed = (namespace: object, pattern: RegExp): string[] =>
  Object.entries(namespace)
    .filter(([name, value]) => typeof value === "function" && pattern.test(name))
    .map(([name]) => name);

describe("the shipped seams (merge note, readings 207 and 209; flags in round4-merge.ts)", () => {
  it("are found exactly when the integrator's merge flags say they have landed", () => {
    const factories = shippedAutomationFactories();
    expect(Object.keys(factories).sort()).toEqual(
      (["evidence", "plumbing"] as const).filter((key) => ROUND4_LANDED[key]),
    );
    for (const f of Object.values(factories)) expect(typeof f).toBe("function");
    expect(typeof shippedArmPluginCompilerFactory()).toBe(
      ROUND4_LANDED.armPlugins ? "function" : "undefined",
    );
  });

  it("leave no seam of the engine or compiler unwired under another name", () => {
    // a renamed export would leave its seam out without a word: fail while one exists unwired
    const factories = shippedAutomationFactories();
    if (factories.plumbing === undefined)
      expect(functionsNamed(git, /Plumbing/), "git plumbing export not wired").toEqual([]);
    if (factories.evidence === undefined)
      expect(functionsNamed(gates, /EvidenceRecorder/), "evidence recorder not wired").toEqual([]);
    if (shippedArmPluginCompilerFactory() === undefined)
      expect(
        functionsNamed(compiler, /(^arm|Arm)(?=[A-Z]|$)/),
        "arm plugin compiler not wired",
      ).toEqual([]);
  });
});
