/** Toolchain detection and `vtc calibrate` (§7.1, §15). */
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  GATE_SANDBOX,
  GatesConfigSchema,
  gateCommandAllowed,
  TOOL_TAMPER_RULE_ID,
  type GateReport,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument, parseAllDocuments } from "yaml";
import { createGitOps } from "../../src/git/index.js";
import {
  allowlistPrefix,
  calibrate,
  detectVisualApp,
  LOOPBACK_QUESTION,
  visualAppQuestion,
  DEFAULT_PROTECTED_GLOBS,
  detectToolchain,
  flakyBetween,
  osvDatabaseReady,
  parseGatesConfig,
  readAllowlist,
  slotOf,
  splitCommand,
  stringifyGatesConfig,
} from "../../src/gates/index.js";
import { tamperAdvice } from "../../src/gates/calibrate/calibrate.js";
import { cleanupDirs, initRepo, tempDir, writeFile } from "../helpers/repo.js";
import {
  cases,
  commitAll,
  config,
  fakeScanners,
  installGate,
  NODE,
  osvGate,
  recordingSandbox,
  testsGate,
  TOOLS,
} from "./fixture.js";

afterEach(cleanupDirs);

/** `visual.app` of `gates.yml` text, read only through the typed config (contracts 4.6.0). */
const appOf = (text: string) => parseGatesConfig(text).visual?.app ?? null;

const SCANNERS = ["gitleaks", "osv-scanner", "opengrep", "checkov"];

/** A typical pnpm + Vitest + ESLint repository with hints, CI and a devcontainer. */
const nodeRepo = (): string => {
  const root = tempDir("vtc-detect-");
  writeFile(
    root,
    "package.json",
    JSON.stringify({
      name: "app",
      scripts: {
        build: "tsc -b",
        lint: "eslint .",
        test: "vitest run",
        dev: "vite",
        "deps:check": "depcruise src",
      },
      devDependencies: { vitest: "4.0.0", eslint: "9.0.0", typescript: "5.9.0" },
    }),
  );
  writeFile(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  writeFile(root, "AGENTS.md", "Run `pnpm typecheck` before pushing. Never run `rm -rf /`.\n");
  writeFile(
    root,
    ".github/workflows/ci.yml",
    "jobs:\n  ci:\n    steps:\n      - run: pnpm install --frozen-lockfile\n      - run: pnpm test && pnpm lint\n",
  );
  writeFile(root, "src/index.ts", "export const a = 1;\n");
  writeFile(root, "tests/a.test.ts", "it('x', () => {});\n");
  writeFile(root, "eslint.config.js", "export default [];\n");
  writeFile(root, "vitest.config.ts", "export default {};\n");
  writeFile(root, "packages/ui/tsconfig.json", "{}\n");
  writeFile(root, "infra/main.tf", 'resource "x" "y" {}\n');
  return root;
};

describe("command parsing and classification", () => {
  it("splits plain commands and refuses anything that needs a shell", () => {
    expect(splitCommand("pnpm run test")).toEqual(["pnpm", "run", "test"]);
    expect(splitCommand("pnpm test && pnpm lint")).toBeNull();
    expect(splitCommand("echo $HOME")).toBeNull();
    expect(splitCommand("rm -rf `x`")).toBeNull();
  });
  it("classifies scripts by what they do", () => {
    expect(slotOf("test")).toBe("test");
    expect(slotOf("test:ci")).toBe("test");
    expect(slotOf("lint")).toBe("lint");
    expect(slotOf("typecheck")).toBe("typecheck");
    expect(slotOf("pnpm install --frozen-lockfile")).toBe("install");
    expect(slotOf("deps:check")).toBe("arch");
    expect(slotOf("dev")).toBeNull();
    expect(slotOf("format")).toBeNull();
  });
  it("cuts the allowlist prefix before the first placeholder", () => {
    expect(allowlistPrefix(["eslint", "--format", "json", "{changed}"])).toEqual([
      "eslint",
      "--format",
      "json",
    ]);
    expect(allowlistPrefix(["pnpm", "test"])).toEqual(["pnpm", "test"]);
  });
});

describe("detectToolchain (§7.1 sources in order)", () => {
  it("proposes gates from hints, task runners, CI and lockfiles, with reports and scanners", () => {
    const root = nodeRepo();
    const detection = detectToolchain(root, { scanners: SCANNERS });
    const byId = Object.fromEntries(detection.gates.map((g) => [g.id, g]));
    expect(detection.gates.map((g) => [g.id, g.layer])).toEqual([
      ["install", "L0"],
      ["build", "L0"],
      ["typecheck", "L0"],
      ["lint", "L1"],
      ["test", "L2"],
      ["arch", "L6"],
      ["secrets", "L4"],
      ["sast", "L4"],
      ["dependencies", "L4"],
      ["iac", "L4"],
    ]);
    expect(byId.typecheck?.command).toEqual(["pnpm", "typecheck"]);
    expect(byId.install).toMatchObject({
      command: ["pnpm", "install", "--frozen-lockfile"],
      phase: "install",
    });
    expect(byId.test).toMatchObject({
      command: [
        "pnpm",
        "exec",
        "vitest",
        "run",
        "--reporter=default",
        "--reporter=junit",
        "--outputFile.junit=.vtc/state/gates/junit.xml",
      ],
      report: { format: "junit", path: ".vtc/state/gates/junit.xml" },
    });
    expect(byId.lint?.report).toEqual({ format: "json", path: ".vtc/state/gates/eslint.json" });
    expect(byId.iac?.when_changed).toContain("**/*.tf");
    // CI's install line wins over the lockfile's; `pnpm test && pnpm lint` needs a shell and is skipped.
    expect(detection.sources).toEqual(["agents_md", "task_runner", "ci"]);
    // Every config glob, matched or not: a config a later diff adds is protected too.
    expect(detection.tests).toEqual({
      acceptance_globs: ["tests/acceptance/**"],
      protected_configs: [...DEFAULT_PROTECTED_GLOBS],
    });
    expect(detection.tests.protected_configs).toContain("**/conftest.py");
    expect(detection.tests.protected_configs).toContain("**/.gitleaksignore");
  });

  it("detects Python and Go toolchains from their lockfiles", () => {
    const py = tempDir();
    writeFile(py, "pyproject.toml", "[tool.pytest.ini_options]\n[tool.ruff]\n");
    writeFile(py, "uv.lock", "");
    const pyGates = detectToolchain(py, { scanners: [] }).gates;
    expect(pyGates.map((g) => g.command)).toEqual([
      ["uv", "sync", "--frozen"],
      [
        "uv",
        "run",
        "ruff",
        "check",
        "--output-format",
        "json",
        "--output-file",
        ".vtc/state/gates/ruff.json",
      ],
      ["uv", "run", "pytest", "--junitxml=.vtc/state/gates/junit.xml"],
    ]);
    const go = tempDir();
    writeFile(go, "go.mod", "module x\n");
    const goDetection = detectToolchain(go, { scanners: [] });
    expect(goDetection.gates.map((g) => g.id)).toEqual(["install", "build", "typecheck", "test"]);
    expect(goDetection.notes.join("\n")).toMatch(/no JUnit report/);
  });

  it("proposes no frozen install for a package.json without a lockfile", () => {
    const repo = tempDir();
    writeFile(repo, "package.json", JSON.stringify({ scripts: { test: "node --test" } }));
    const detection = detectToolchain(repo, { scanners: [] });
    expect(detection.gates.map((g) => g.id)).not.toContain("install");
    expect(detection.gates.flatMap((g) => g.command)).not.toContain("ci");
    expect(detection.sources).toEqual(["task_runner"]);
    expect(detection.notes.join("\n")).toMatch(/no lockfile: no install gate proposed/);
  });

  it("keeps the gates of an existing gates.yml (source 1)", () => {
    const existing = parseGatesConfig(config([testsGate]));
    const detection = detectToolchain(nodeRepo(), { existing, scanners: SCANNERS });
    expect(detection.gates.map((g) => g.id)).toEqual(["tests"]);
    expect(detection.sources).toEqual(["gates_yml"]);
  });
});

describe("detectVisualApp (the visual step's app server)", () => {
  it("proposes the dev script on the port its server uses", () => {
    expect(detectVisualApp(nodeRepo()).app).toEqual({
      command: ["pnpm", "run", "dev"],
      url: "http://localhost:5173",
      script: "dev",
    });
  });

  it("prefers an explicit port, skips scripts with no known port, and needs a package.json", () => {
    const root = tempDir("vtc-detect-");
    writeFile(
      root,
      "package.json",
      JSON.stringify({ scripts: { dev: "node server.js", start: "next start -p 4100" } }),
    );
    const found = detectVisualApp(root);
    expect(found.app).toEqual({
      command: ["npm", "run", "start"],
      url: "http://localhost:4100",
      script: "start",
    });
    expect(found.notes.join("\n")).toMatch(/dev script .* names no port/);
    expect(detectVisualApp(tempDir("vtc-empty-")).app).toBeNull();
  });
});

describe("gates.yml is plain YAML (integrator follow-up 1)", () => {
  it("has no anchors, aliases, tags, block scalars or second document, and round-trips", () => {
    const text = stringifyGatesConfig(
      GatesConfigSchema.parse({
        version: 1,
        baseline: {
          revision: "a".repeat(40),
          calibrated_at: "2026-10-13T08:00:00.000Z",
          confirmed: true,
          flaky_tests: ["a > b: c", "a > b: c 2"],
        },
        tests: { acceptance_globs: ["tests/acceptance/**"], protected_configs: ["**/*.config.ts"] },
        gates: [
          {
            id: "t",
            layer: "L2",
            command: ["x", "--msg=multi\nline", "*star", "&amp", "!tag", "- dash", "#hash"],
          },
          {
            id: "u",
            layer: "L2",
            command: ["x", "--msg=multi\nline", "*star", "&amp", "!tag", "- dash", "#hash"],
          },
        ],
      }),
    );
    expect(parseAllDocuments(text)).toHaveLength(1);
    const doc = parseDocument(text);
    expect(doc.errors).toEqual([]);
    expect(text).not.toMatch(/^\s*[^#\n]*[:-]\s+[|>][-+]?\s*$/m);
    expect(text).not.toMatch(/(^|\s)[&*!][\w-]+\s*$/m);
    expect(parseGatesConfig(text).gates[0]?.command[1]).toBe("--msg=multi\nline");
  });
});

describe("calibrate", () => {
  const setup = (gates = [installGate, testsGate]) => {
    const repo = initRepo({ ...TOOLS, ".lintrc": "strict\n" });
    const counter = join(tempDir(), "count");
    writeFile(
      repo,
      "tests/unit.json",
      cases([{ name: "stable" }, { name: "wobbly", flaky: counter }]),
    );
    writeFile(repo, ".vtc/gates.yml", config(gates).replace("confirmed: true", "confirmed: false"));
    const revision = commitAll(repo, "base");
    const home = tempDir("vtc-home-");
    const lines: string[] = [];
    const answers: string[] = [];
    const recording = recordingSandbox();
    const deps = (answer: (q: string) => boolean) => ({
      sandbox: recording.sandbox,
      repoRoot: repo,
      vtcHome: home,
      git: createGitOps({ repoRoot: repo }),
      revision,
      out: (line: string) => lines.push(line),
      confirm: (q: string) => {
        answers.push(q);
        return Promise.resolve(answer(q));
      },
      now: () => new Date("2026-10-13T09:00:00.000Z"),
      scanners: fakeScanners(home),
      env: process.env,
    });
    return { repo, home, revision, lines, answers, deps, specs: recording.specs };
  };

  it("runs every command in the gate sandbox, the OSV download in the install phase", async () => {
    const s = setup([installGate, testsGate, osvGate]);
    await calibrate(s.deps(() => true));
    // The download, then twice: install, tests, dependencies.
    expect(s.specs.map((x) => x.phase)).toEqual([
      "install",
      "install",
      "verify",
      "verify",
      "install",
      "verify",
      "verify",
    ]);
    for (const x of s.specs) expect(x.denyRead).toContain(join(s.home, "allowlists"));
  });

  it("refuses to calibrate without a sandbox, before asking or running anything", async () => {
    const s = setup();
    const { sandbox: _unused, ...rest } = s.deps(() => true);
    await expect(calibrate({ ...rest, detectSandbox: () => null })).rejects.toThrow(
      GATE_SANDBOX.noSandboxReason,
    );
    expect(s.answers).toEqual([]);
    expect(readAllowlist(s.home, s.repo).commands).toEqual([]);
    // A dry run runs nothing, so it needs no sandbox.
    const dry = await calibrate({ ...rest, detectSandbox: () => null }, { dryRun: true });
    expect(dry.status).toBe("dry_run");
  });

  it("calibrates unconfined under the user-level opt-in and says so", async () => {
    const s = setup();
    const { sandbox: _unused, ...rest } = s.deps(() => true);
    const outcome = await calibrate({ ...rest, detectSandbox: () => null, allowUnsandboxed: true });
    expect(outcome).toMatchObject({ status: "frozen" });
    expect(s.lines.join("\n")).toMatch(/WARNING: no OS sandbox for gates: .*unconfined/);
  });

  it("warns which gates runs mark after_scripts: a tool hashed only after an install's scripts (reading 251)", async () => {
    const build = {
      id: "build",
      layer: "L0" as const,
      command: [NODE, "tools/build.mjs"],
      tool: { source: "project" as const, paths: ["tools/build.mjs"] },
    };
    const s = setup([installGate, build]);
    await calibrate(s.deps(() => true));
    // calibration itself measures the base, so the gate ran and is kept
    expect(s.lines.join("\n")).toMatch(/L0 build: pass\/pass/);
    expect(s.lines.join("\n")).toMatch(
      /WARNING: gate\(s\) build: .*hashed only after install gate\(s\) install ran their scripts.*runs mark these gates after_scripts and warn on their reports/,
    );
    // the old user-level opt-in changes nothing any more (reading 251)
    const opted = setup([installGate, build]);
    await calibrate({ ...opted.deps(() => true), allowToolsHashedAfterScripts: true });
    expect(opted.lines.join("\n")).toMatch(/runs mark these gates after_scripts/);
  });

  it("asks before running anything, runs twice, records flaky tests and freezes the baseline", async () => {
    const s = setup();
    const outcome = await calibrate(s.deps(() => true));
    expect(s.answers).toEqual([
      "Allow these commands for this repo on this machine?",
      LOOPBACK_QUESTION,
      "Freeze this as the baseline?",
    ]);
    expect(gateCommandAllowed([NODE, "tools/install.mjs"], readAllowlist(s.home, s.repo))).toBe(
      true,
    );
    expect(outcome).toMatchObject({ status: "frozen", flaky: ["tests/unit.json > wobbly"] });
    const written = parseGatesConfig(readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8"));
    expect(written.baseline).toEqual({
      revision: s.revision,
      calibrated_at: "2026-10-13T09:00:00.000Z",
      confirmed: true,
      flaky_tests: ["tests/unit.json > wobbly"],
    });
    expect(s.lines.join("\n")).toMatch(/L2 tests: /);
    // Engine core and the Gate Runner read gates.yml at the run's base commit (D-z f).
    expect(s.lines.join("\n")).toMatch(
      /Commit \.vtc\/gates\.yml now: runs read it at their base commit and park until it is committed/,
    );
  });

  it("asks whether the suite needs the loopback, and records only a yes in gates.yml (D-av)", async () => {
    const yes = setup();
    await calibrate(yes.deps(() => true));
    const on = parseGatesConfig(readFileSync(join(yes.repo, ".vtc/gates.yml"), "utf8"));
    expect(on.sandbox).toEqual({ verify_loopback: true });
    // both calibration runs already used it, in the verify phase only
    expect(yes.specs.filter((x) => x.phase === "verify").every((x) => x.loopback === true)).toBe(
      true,
    );
    expect(yes.specs.filter((x) => x.phase === "install").some((x) => x.loopback === true)).toBe(
      false,
    );
    const no = setup();
    await calibrate(no.deps((q) => q !== LOOPBACK_QUESTION));
    const off = parseGatesConfig(readFileSync(join(no.repo, ".vtc/gates.yml"), "utf8"));
    expect(off.sandbox).toBeUndefined();
    expect(no.specs.some((x) => x.loopback === true)).toBe(false);
  });

  it("runs nothing and writes nothing when the human declines the commands", async () => {
    const s = setup();
    const before = readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8");
    const outcome = await calibrate(s.deps(() => false));
    expect(outcome).toMatchObject({ status: "commands_not_confirmed" });
    expect(s.answers).toHaveLength(1);
    expect(readAllowlist(s.home, s.repo).commands).toEqual([]);
    expect(readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8")).toBe(before);
  });

  it("writes an unconfirmed baseline when the human declines to freeze it", async () => {
    const s = setup();
    const outcome = await calibrate(s.deps((q) => q.startsWith("Allow")));
    expect(outcome).toMatchObject({ status: "not_frozen" });
    expect(
      parseGatesConfig(readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8")).baseline.confirmed,
    ).toBe(false);
  });

  it("proposes the visual app server, and only a human's yes writes it and allowlists it", async () => {
    const s = setup();
    writeFile(s.repo, "package.json", JSON.stringify({ scripts: { dev: "vite --port 4000" } }));
    writeFile(
      s.repo,
      ".vtc/gates.yml",
      `${readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8")}visual:\n  widths: [390]\n`,
    );
    const question = visualAppQuestion({
      command: ["npm", "run", "dev"],
      url: "http://localhost:4000",
    });
    // The human is told which port of the host's loopback the sandbox then opens.
    expect(question).toMatch(/port 4000 of this machine's loopback/);
    await calibrate(s.deps(() => true));
    expect(s.answers[0]).toBe(question);
    const text = readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8");
    // the typed config carries it since contracts 4.6.0 (`GatesConfig.visual.app`, reading 121)
    expect(parseGatesConfig(text).visual).toEqual({
      widths: [390],
      app: { command: ["npm", "run", "dev"], url: "http://localhost:4000", ready_timeout_s: 120 },
    });
    expect(parseAllDocuments(text)).toHaveLength(1);
    expect(gateCommandAllowed(["npm", "run", "dev"], readAllowlist(s.home, s.repo))).toBe(true);
    expect(s.lines.join("\n")).toMatch(/npm run dev {2}\(the visual step's app server\)/);

    // Re-calibration keeps it without asking again.
    const before = s.answers.length;
    await calibrate(s.deps(() => true));
    expect(s.answers.slice(before)).not.toContain(question);
    expect(parseGatesConfig(readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8")).visual).toEqual({
      widths: [390],
      app: { command: ["npm", "run", "dev"], url: "http://localhost:4000", ready_timeout_s: 120 },
    });
  });

  it("keeps a hand-written visual app server and the other visual settings on re-calibration", async () => {
    const s = setup();
    // No package.json: nothing to propose, so only the hand-written app can be there afterwards.
    writeFile(
      s.repo,
      ".vtc/gates.yml",
      `${readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8")}visual:\n  themes: [light, dark]\n  dynamic_regions: [".clock"]\n  app:\n    command: ["${NODE}", "tools/serve.mjs"]\n    url: http://127.0.0.1:4173\n    cwd: web\n    ready_timeout_s: 30\n`,
    );
    const outcome = await calibrate(s.deps(() => true));
    expect(outcome).toMatchObject({ status: "frozen" });
    const visual = {
      themes: ["light", "dark"],
      dynamic_regions: [".clock"],
      app: {
        command: [NODE, "tools/serve.mjs"],
        url: "http://127.0.0.1:4173",
        cwd: "web",
        ready_timeout_s: 30,
      },
    };
    if (outcome.status !== "frozen") throw new Error("not frozen");
    expect(outcome.config.visual).toEqual(visual);
    expect(parseGatesConfig(readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8")).visual).toEqual(
      visual,
    );
    expect(s.answers.some((q) => q.startsWith("Use `"))).toBe(false);
    expect(s.lines.join("\n")).toMatch(/kept the visual app server of \.vtc\/gates\.yml/);
    expect(gateCommandAllowed([NODE, "tools/serve.mjs"], readAllowlist(s.home, s.repo))).toBe(true);
  });

  it("writes no visual app server and allowlists nothing for it when the human says no", async () => {
    const s = setup();
    writeFile(s.repo, "package.json", JSON.stringify({ scripts: { dev: "vite" } }));
    await calibrate(s.deps((q) => !q.startsWith("Use `")));
    expect(appOf(readFileSync(join(s.repo, ".vtc/gates.yml"), "utf8"))).toBeNull();
    expect(gateCommandAllowed(["npm", "run", "dev"], readAllowlist(s.home, s.repo))).toBe(false);
    expect(s.lines.join("\n")).toMatch(/no visual app server/);
  });

  it("prints a dry run without running or asking", async () => {
    const s = setup();
    const outcome = await calibrate(
      s.deps(() => true),
      { dryRun: true },
    );
    expect(outcome.status).toBe("dry_run");
    expect(s.answers).toEqual([]);
  });

  it("shows the scanners' arguments and downloads the OSV database only when the human says yes", async () => {
    const s = setup([installGate, testsGate, osvGate]);
    const outcome = await calibrate(s.deps(() => true));
    expect(s.answers).toEqual([
      "Allow these commands for this repo on this machine?",
      LOOPBACK_QUESTION,
      "Download the OSV offline vulnerability database now (network)?",
      "Freeze this as the baseline?",
    ]);
    expect(s.lines).toContain(`  dependencies: ${osvGate.command.join(" ")}`);
    expect(osvDatabaseReady(s.home)).toBe(true);
    expect(outcome).toMatchObject({ status: "frozen" });
    if (outcome.status !== "frozen") throw new Error("not frozen");
    expect(outcome.config.gates.map((g) => g.id)).toContain("dependencies");
  });

  it("warns loudly when the dependency gate cannot run and is dropped", async () => {
    const s = setup([installGate, testsGate, osvGate]);
    const outcome = await calibrate(s.deps((q) => !q.startsWith("Download")));
    expect(osvDatabaseReady(s.home)).toBe(false);
    if (outcome.status !== "frozen") throw new Error("not frozen");
    expect(outcome.config.gates.map((g) => g.id)).not.toContain("dependencies");
    const text = s.lines.join("\n");
    expect(text).toMatch(/WARNING: dropped L4 gate dependencies: .* NOT active/);
    expect(text).toMatch(/needs the OSV offline database/);
  });

  it("compares two runs' outcomes per test", () => {
    expect(
      flakyBetween(
        new Map([
          ["a", "pass"],
          ["b", "fail"],
          ["c", "pass"],
        ]),
        new Map([
          ["a", "pass"],
          ["b", "pass"],
          ["d", "pass"],
        ]),
      ),
    ).toEqual(["b", "c", "d"]);
  });
});

describe("calibrate records each check gate's tool (H-14, reading 238)", () => {
  it("writes the project tool installed in the working tree, a package script's too, and none for pinned scanners", async () => {
    const root = nodeRepo();
    const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    manifest.scripts.typecheck = "tsc --noEmit";
    for (const dep of ["typescript-eslint", "@vue/eslint-plugin", "prettier", "eslint-plugin-gone"])
      manifest.devDependencies[dep] = "1.0.0";
    writeFile(root, "package.json", JSON.stringify(manifest));
    for (const [pkg, file, bin] of [
      ["eslint", "bin/eslint.js", "eslint"],
      ["vitest", "vitest.mjs", "vitest"],
      ["typescript", "bin/tsc", "tsc"],
      ["typescript-eslint", "dist/index.js", null],
      ["@vue/eslint-plugin", "index.js", null],
      ["prettier", "index.js", null],
    ] as const) {
      writeFile(root, `node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg }));
      writeFile(root, `node_modules/${pkg}/${file}`, "#!/usr/bin/env node\n");
      if (bin === null) continue;
      mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
      symlinkSync(`../${pkg}/${file}`, join(root, "node_modules/.bin", bin));
    }
    const lines: string[] = [];
    const outcome = await calibrate(
      {
        repoRoot: root,
        vtcHome: tempDir(),
        git: createGitOps({ repoRoot: initRepo() }),
        revision: "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
        out: (line) => lines.push(line),
        confirm: () => Promise.resolve(false),
        scanners: { names: SCANNERS, ensure: () => Promise.reject(new Error("no downloads")) },
      },
      { dryRun: true },
    );
    if (outcome.status !== "dry_run") throw new Error("expected a dry run");
    const tools = Object.fromEntries(
      parseGatesConfig(outcome.yaml).gates.map((g) => [g.id, g.tool ?? null]),
    );
    const tsc = {
      source: "project",
      paths: ["node_modules/.bin/tsc", "node_modules/typescript/**"],
    };
    expect(tools).toEqual({
      install: null,
      // Package scripts: `pnpm run build` runs `tsc -b`, `pnpm typecheck` runs `tsc --noEmit`.
      build: tsc,
      typecheck: tsc,
      // The lint gate's tool has the ESLint plugins and parsers the package.json names too
      // (ESLint loads them through its config); `eslint-plugin-gone` is not installed.
      lint: {
        source: "project",
        paths: [
          "node_modules/.bin/eslint",
          "node_modules/eslint/**",
          "node_modules/@vue/eslint-plugin/**",
          "node_modules/typescript-eslint/**",
        ],
      },
      test: { source: "project", paths: ["node_modules/.bin/vitest", "node_modules/vitest/**"] },
      secrets: null,
      dependencies: null,
      sast: null,
      iac: null,
      // `depcruise` is not installed in this working tree.
      arch: null,
    });
    expect(lines.join("\n")).toMatch(/recorded the check tool of build, typecheck, lint, test/);
  });

  it("replaces a recorded tool that went stale or matches nothing, and keeps one that still covers (reading 249)", async () => {
    const root = nodeRepo();
    for (const [pkg, file, bin] of [
      ["eslint", "bin/eslint.js", "eslint"],
      ["vitest", "vitest.mjs", "vitest"],
    ] as const) {
      writeFile(root, `node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg }));
      writeFile(root, `node_modules/${pkg}/${file}`, "#!/usr/bin/env node\n");
      mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
      symlinkSync(`../${pkg}/${file}`, join(root, "node_modules/.bin", bin));
    }
    const kept = {
      source: "project" as const,
      paths: ["node_modules/.bin/vitest", "node_modules/vitest/**", "vitest.config.ts"],
    };
    writeFile(
      root,
      ".vtc/gates.yml",
      config([
        {
          id: "lint",
          layer: "L1",
          command: ["pnpm", "exec", "eslint", "."],
          // a pnpm real-path fallback from before a version bump: it matches no file now
          tool: { source: "project", paths: ["node_modules/.pnpm/eslint@0.9.0/**"] },
        },
        { id: "test", layer: "L2", command: ["pnpm", "exec", "vitest", "run"], tool: kept },
        {
          id: "typecheck",
          layer: "L1",
          command: ["pnpm", "exec", "vitest", "typecheck"],
          // no longer covers the package it runs (moved, or a hand edit gone wrong)
          tool: { source: "project", paths: ["node_modules/.bin/vitest", "gone/**"] },
        },
      ]),
    );
    const lines: string[] = [];
    const outcome = await calibrate(
      {
        repoRoot: root,
        vtcHome: tempDir(),
        git: createGitOps({ repoRoot: initRepo() }),
        revision: "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
        out: (line) => lines.push(line),
        confirm: () => Promise.resolve(false),
        scanners: { names: SCANNERS, ensure: () => Promise.reject(new Error("no downloads")) },
      },
      { dryRun: true },
    );
    if (outcome.status !== "dry_run") throw new Error("expected a dry run");
    const tools = Object.fromEntries(
      parseGatesConfig(outcome.yaml).gates.map((g) => [g.id, g.tool ?? null]),
    );
    expect(tools).toEqual({
      lint: { source: "project", paths: ["node_modules/.bin/eslint", "node_modules/eslint/**"] },
      // a hand-written tool that still covers what its command runs is kept
      test: kept,
      typecheck: {
        source: "project",
        paths: ["node_modules/.bin/vitest", "node_modules/vitest/**"],
      },
    });
    expect(lines.join("\n")).toMatch(/replaced the stale check tool of lint, typecheck/);
  });

  it("asks the human to confirm the second pass of a two-pass install too", async () => {
    const root = nodeRepo();
    const outcome = await calibrate({
      repoRoot: root,
      vtcHome: tempDir(),
      git: createGitOps({ repoRoot: initRepo() }),
      revision: "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
      out: () => undefined,
      confirm: () => Promise.resolve(false),
      scanners: { names: SCANNERS, ensure: () => Promise.reject(new Error("no downloads")) },
      detectSandbox: () => null,
      allowUnsandboxed: true,
    });
    if (outcome.status !== "commands_not_confirmed") throw new Error("expected no confirmation");
    expect(outcome.pending.slice(0, 2)).toEqual([
      ["pnpm", "install", "--frozen-lockfile"],
      ["pnpm", "rebuild", "--recursive", "--pending"],
    ]);
  });
});

describe("the calibrated fixture", () => {
  it("is what calibrate writes for a typical repo (test/gates/fixtures/gates-calibrated.yml)", async () => {
    const root = nodeRepo();
    const repo = initRepo();
    const outcome = await calibrate(
      {
        repoRoot: root,
        vtcHome: tempDir(),
        git: createGitOps({ repoRoot: repo }),
        revision: "4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
        out: () => undefined,
        confirm: () => Promise.resolve(false),
        now: () => new Date("2026-10-13T08:00:00.000Z"),
        scanners: {
          names: SCANNERS,
          ensure: () => Promise.reject(new Error("no downloads in tests")),
        },
      },
      { dryRun: true },
    );
    if (outcome.status !== "dry_run") throw new Error("expected a dry run");
    // What calibrate writes once the human confirms and both runs agree (no flaky tests).
    // The proposed app server is shown in the dry run (`visual.app`, tested above); the fixture
    // is the rest of the config.
    expect(appOf(outcome.yaml)).toMatchObject({ command: ["pnpm", "run", "dev"] });
    const { visual, ...proposed } = parseGatesConfig(outcome.yaml);
    expect(visual?.app?.command).toEqual(["pnpm", "run", "dev"]);
    const frozen = stringifyGatesConfig({
      ...proposed,
      baseline: { ...proposed.baseline, confirmed: true },
    });
    const fixture = readFileSync(
      join(import.meta.dirname, "fixtures/gates-calibrated.yml"),
      "utf8",
    );
    expect(frozen).toBe(fixture);
    expect(GatesConfigSchema.parse(parseDocument(fixture).toJS())).toBeDefined();
  });
});

describe("calibrate says what to do about a code generator in the install (spine §5 reading 253(a))", () => {
  /** A report whose `tampered` gates failed as tampering, and one gate that passed. */
  const report = (tampered: Record<string, string[]>): GateReport =>
    ({
      results: [
        ...Object.entries(tampered).map(([id, paths]) => ({
          gate_id: id,
          status: "fail",
          findings: [{ rule_id: TOOL_TAMPER_RULE_ID }],
          tool: { source: "project", tampered: paths },
        })),
        { gate_id: "lint", status: "pass", findings: [] },
      ],
    }) as unknown as GateReport;

  it("names Prisma's generator and the install gate that replaces its install script", () => {
    const advice = tamperAdvice(
      report({
        test: ["node_modules/.pnpm/@prisma+client@5.0.0/node_modules/.prisma/client/index.js"],
        build: ["node_modules/.prisma/client/index.d.ts"],
      }),
    );
    expect(advice).toMatch(/^WARNING: gate\(s\) test, build fail on the base commit as tampering/);
    expect(advice).toMatch(/Prisma's client generator/);
    expect(advice).toMatch(/command: \[npx, prisma, generate\]/);
  });

  it("gives the general advice for any other write, and nothing when no gate failed so", () => {
    expect(tamperAdvice(report({ test: ["node_modules/.cache-gen/out.js"] }))).toMatch(
      /changed node_modules\/\.cache-gen\/out\.js.*add the generator as an install gate after the install/,
    );
    expect(tamperAdvice(report({}))).toBeNull();
  });
});
