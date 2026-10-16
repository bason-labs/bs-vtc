/**
 * Check tools that install scripts cannot replace (H-14; spine §5 readings 80(c) and 238), end to
 * end through the Gate Runner on real git checkouts: the scripts-free install first, the hash of
 * each check gate's `project` tool, the install with its scripts, the re-hash just before the
 * gate, and a pinned tool run from the store.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_TAMPER_RULE_ID, type GateReport, type GateResult } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ScannerUnavailableError } from "../../src/gates/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import { commitAll, config, fakeScanners, harness, leaksGate, NODE, TOOLS } from "./fixture.js";

/** Repositories a test locked a directory in, made removable again first. */
const unlock: string[] = [];

afterEach(() => {
  for (const dir of unlock.splice(0)) execFileSync("chmod", ["-R", "u+rwx", dir]);
  cleanupDirs();
});

/**
 * A fake npm: `ci` installs the committed `vendor/lint.mjs` as the package `lint-tool` (with a
 * `.bin` link) and, when the checkout has a `postinstall.mjs`, the dependency `postinstall-dep`
 * whose postinstall runs it from the checkout's root; unless `--ignore-scripts`, it then runs
 * every installed package's install scripts. `rebuild <name>` runs the install scripts of the
 * installed packages named `<name>` in their own directory, as npm does; `run` runs a package
 * script (`--ignore-scripts`: without its pre and post scripts).
 */
const FAKE_NPM = `#!/usr/bin/env node
const { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { dirname, resolve: resolvePath } = require("node:path");
const { spawnSync } = require("node:child_process");
let args = process.argv.slice(2);
// \`npm --prefix <dir> ...\`: runs in <dir>
const prefix = args.indexOf("--prefix");
if (prefix >= 0) {
  process.chdir(args[prefix + 1]);
  args = [...args.slice(0, prefix), ...args.slice(prefix + 2)];
}
const ignoring = args.includes("--ignore-scripts");
args = args.filter((a) => a !== "--ignore-scripts");
/** Runs the install scripts of the installed package in \`dir\` there, as npm does. */
const lifecycle = (dir) => {
  const scripts = JSON.parse(readFileSync(dir + "/package.json", "utf8")).scripts ?? {};
  for (const name of ["preinstall", "install", "postinstall"]) {
    if (typeof scripts[name] !== "string") continue;
    const r = spawnSync("/bin/sh", ["-c", scripts[name]], { stdio: "inherit", cwd: dir });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
};
/** Every installed package directory under node_modules (scoped ones included). */
const installed = () => {
  const { readdirSync, lstatSync } = require("node:fs");
  const found = [];
  const walk = (modules) => {
    if (!existsSync(modules)) return;
    for (const name of readdirSync(modules)) {
      if (name.startsWith(".")) continue;
      const dir = modules + "/" + name;
      if (lstatSync(dir).isSymbolicLink()) continue;
      if (name.startsWith("@")) { walk(dir); continue; }
      if (existsSync(dir + "/package.json")) { found.push(dir); walk(dir + "/node_modules"); }
    }
  };
  walk("node_modules");
  return found;
};
if (args[0] === "rebuild") {
  for (const dir of installed()) {
    if (JSON.parse(readFileSync(dir + "/package.json", "utf8")).name === args[1]) lifecycle(dir);
  }
  process.exit(0);
}
if (args[0] === "run") {
  // \`npm run <script>\`: the script through the npmrc's script-shell (default sh) and with its
  // node-options, the project's .npmrc first and then the user's $HOME/.npmrc, with the nearest
  // node_modules/.bin on PATH, as npm runs it
  const resolve = resolvePath;
  const script = JSON.parse(readFileSync("package.json", "utf8")).scripts[args[1]];
  const user = process.env.HOME === undefined ? "" : resolvePath(process.env.HOME, ".npmrc");
  const rc = [".npmrc", user].filter((f) => f !== "" && existsSync(f)).map((f) => readFileSync(f, "utf8")).join("\\n");
  const shell = /^script-shell=(.*)$/m.exec(rc)?.[1]?.trim() ?? "/bin/sh";
  const nodeOptions = /^node-options=(.*)$/m.exec(rc)?.[1]?.trim();
  const env = { ...process.env, PATH: resolve("node_modules/.bin") + ":" + process.env.PATH, ...(nodeOptions === undefined ? {} : { NODE_OPTIONS: nodeOptions }) };
  const r = spawnSync(shell, ["-c", [script, ...args.slice(2)].join(" ")], { stdio: "inherit", env });
  process.exit(r.status ?? 1);
}
if (args[0] !== "ci") process.exit(2);
rmSync("node_modules", { recursive: true, force: true });
mkdirSync("node_modules/lint-tool", { recursive: true });
copyFileSync("vendor/lint.mjs", "node_modules/lint-tool/lint.mjs");
chmodSync("node_modules/lint-tool/lint.mjs", 0o755);
writeFileSync("node_modules/lint-tool/package.json", JSON.stringify({ name: "lint-tool", bin: { "lint-tool": "lint.mjs" } }));
mkdirSync("node_modules/.bin", { recursive: true });
symlinkSync("../lint-tool/lint.mjs", "node_modules/.bin/lint-tool");
if (existsSync("vendor/node_modules")) cpSync("vendor/node_modules", "node_modules", { recursive: true });
// a workspace: \`vendor/tree\` copied over the checkout, then \`vendor/links.json\`'s [link, target] bins
if (existsSync("vendor/tree")) cpSync("vendor/tree", ".", { recursive: true });
// a package kept in a store under $HOME and linked in (pnpm's global virtual store)
if (existsSync("vendor/home-store")) {
  const store = resolvePath(process.env.HOME, "store");
  cpSync("vendor/home-store", store, { recursive: true });
  for (const name of require("node:fs").readdirSync("vendor/home-store")) {
    symlinkSync(resolvePath(store, name), "node_modules/" + name);
  }
}
if (existsSync("vendor/links.json")) {
  for (const [link, target] of JSON.parse(readFileSync("vendor/links.json", "utf8"))) {
    mkdirSync(dirname(link), { recursive: true });
    rmSync(link, { force: true });
    symlinkSync(target, link);
    chmodSync(resolvePath(dirname(link), target), 0o755);
  }
}
if (existsSync("postinstall.mjs")) {
  mkdirSync("node_modules/postinstall-dep", { recursive: true });
  writeFileSync("node_modules/postinstall-dep/package.json", JSON.stringify({ name: "postinstall-dep", scripts: { postinstall: "cd ../.. && node postinstall.mjs" } }));
}
if (!ignoring) for (const dir of installed()) lifecycle(dir);
`;

/** A dependency's install script that swaps the linter for one that never finds anything. */
const TAMPER = `import { writeFileSync } from "node:fs";
writeFileSync("node_modules/lint-tool/lint.mjs", "#!/usr/bin/env node\\nimport { writeFileSync } from 'node:fs';\\nwriteFileSync(process.argv[2], '[]');\\n");
writeFileSync("node_modules/lint-tool/evil.mjs", "// planted\\n");
`;

/** A fake npx: runs the nearest `node_modules/.bin/<name>` from its cwd up, as npx does. */
const FAKE_NPX = `#!/usr/bin/env node
const { existsSync } = require("node:fs");
const { dirname, join } = require("node:path");
const { spawnSync } = require("node:child_process");
const [name, ...rest] = process.argv.slice(2);
for (let dir = process.cwd(); ; dir = dirname(dir)) {
  const bin = join(dir, "node_modules", ".bin", name);
  if (existsSync(bin)) process.exit(spawnSync(bin, rest, { stdio: "inherit" }).status ?? 1);
  if (dirname(dir) === dir) process.exit(127);
}
`;

const LINT = `#!/usr/bin/env node\n${TOOLS["tools/fake-lint.mjs"] ?? ""}`;
const REPORT = ".vtc/state/gates/lint.json";

/** A directory with the fake npm and npx, and a `pnpm` that runs nothing and passes. */
const fakePackageManagers = (): { bin: string; npm: string; npx: string } => {
  const bin = tempDir("vtc-fake-pm-");
  const npm = join(bin, "npm");
  writeFile(bin, "npm", FAKE_NPM);
  chmodSync(npm, 0o755);
  const npx = join(bin, "npx");
  writeFile(bin, "npx", FAKE_NPX);
  chmodSync(npx, 0o755);
  writeFile(bin, "pnpm", "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "pnpm"), 0o755);
  return { bin, npm, npx };
};

const setup = (
  gates: Parameters<typeof config>[0],
  files: Record<string, string> = {},
  options: Pick<NonNullable<Parameters<typeof harness>[2]>, "env"> = {},
) => {
  const { npm, npx } = fakePackageManagers();
  const install = {
    id: "install",
    layer: "L0" as const,
    phase: "install" as const,
    command: [npm, "ci"],
  };
  const h = harness(
    { "vendor/lint.mjs": LINT, "src/a.ts": "export const a = 1;\n", ...files },
    config([install, ...gates]),
    { allow: [[NODE], [npm], [npx], ["node_modules/.bin/lint-tool"]], ...options },
  );
  return { h, npm, npx };
};

const result = (report: GateReport, id: string): GateResult => {
  const found = report.results.find((r) => r.gate_id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
};

const explicitLint = {
  id: "lint",
  layer: "L1" as const,
  command: [NODE, "node_modules/lint-tool/lint.mjs", REPORT, "{changed}"],
  report: { format: "json" as const, path: REPORT },
  tool: { source: "project" as const, paths: ["node_modules/lint-tool/**"] },
};

const lintRan = (argvs: readonly (readonly string[])[]): boolean =>
  argvs.some((a) => a.some((t) => t.includes("lint-tool")) && a.includes(REPORT));

/** The text of one evidence log of the run's (only) attempt. */
const evidenceLog = (repo: string, name: string): string => {
  const evidenceRoot = join(repo, ".vtc/evidence/T-1/gates");
  const attempt = readdirSync(evidenceRoot)[0] ?? "";
  return readFileSync(join(evidenceRoot, attempt, name), "utf8");
};

describe("H-14: a project check tool is hashed after a scripts-free install", () => {
  it("installs without scripts, hashes the tool, installs with scripts, and runs the verified tool", async () => {
    const { h, npm } = setup([explicitLint]);
    writeFile(h.repo, "src/a.ts", "export const a = 2; // TODO\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L1"] });
    const installs = h.argvs.filter((a) => a[0] === npm).map((a) => a.slice(1).join(" "));
    // The base's install too (the baseline of the failing lint), with no hash there.
    expect(installs.slice(0, 2)).toEqual(["ci --ignore-scripts", "ci"]);
    expect(report.results.filter((r) => r.gate_id === "install")).toHaveLength(1);
    expect(result(report, "install").status).toBe("pass");
    const lint = result(report, "lint");
    // The real linter ran: it found the TODO.
    expect(lint).toMatchObject({ status: "fail", failure_class: "product", new_violations: 1 });
    expect(lint.findings[0]?.rule_id).toBe("no-todo");
    expect(lint.tool).toEqual({
      source: "project",
      sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      // reading 251: the workspace's tools, hashed at the same time, whatever the command runs
      workspace_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      tampered: [],
    });
  });

  it("fails the gate as tampering when an install script replaced the tool, and never runs it", async () => {
    const { h } = setup([explicitLint]);
    writeFile(h.repo, "postinstall.mjs", TAMPER);
    writeFile(h.repo, "src/a.ts", "export const a = 2; // TODO\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L1"] });
    const lint = result(report, "lint");
    expect(lint).toMatchObject({
      status: "fail",
      failure_class: "product",
      new_violations: 1,
      tool: {
        source: "project",
        tampered: ["node_modules/lint-tool/evil.mjs", "node_modules/lint-tool/lint.mjs"],
      },
    });
    expect(lint.findings).toHaveLength(1);
    expect(lint.findings[0]).toMatchObject({
      rule_id: TOOL_TAMPER_RULE_ID,
      category: "security",
      location: { path: "node_modules/lint-tool/evil.mjs" },
    });
    expect(report.verdict).toBe("fail");
    expect(lintRan(h.argvs)).toBe(false);
    const log = readFileSync(join(h.repo, lint.evidence[0]?.ref ?? ""), "utf8");
    expect(log).toContain("node_modules/lint-tool/lint.mjs");
  });

  it("derives the tool from command[0] when gates.yml names none, and catches an earlier gate's change", async () => {
    const derived = {
      id: "lint",
      layer: "L1" as const,
      command: ["node_modules/.bin/lint-tool", REPORT, "{changed}"],
      report: { format: "json" as const, path: REPORT },
    };
    const touch = { id: "build", layer: "L0" as const, command: [NODE, "tools/touch.mjs"] };
    const { h } = setup([touch, derived], {
      "tools/touch.mjs": "process.exit(0);\n",
    });
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const clean = await h.run({ head: commitAll(h.repo), layers: ["L0", "L1"] });
    expect(result(clean, "lint")).toMatchObject({ status: "pass", tool: { tampered: [] } });
    expect(lintRan(h.argvs)).toBe(true);
    // The build gate runs a committed script with the node on PATH: it names no tool, yet it is
    // checked against the whole checkout like every other (spine §5 reading 252).
    expect(result(clean, "build").tool).toMatchObject({
      source: "project",
      tampered: [],
      workspace_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
    });

    writeFile(
      h.repo,
      "tools/touch.mjs",
      'import { writeFileSync } from "node:fs";\nwriteFileSync("node_modules/lint-tool/extra.js", "x");\n',
    );
    const report = await h.run({ head: commitAll(h.repo), layers: ["L0", "L1"] });
    expect(result(report, "lint")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: ["node_modules/lint-tool/extra.js"] },
    });
  });

  /** A leading install gate with no scripts-free form, which installs the lint tool. */
  const plainInstall = (options: Parameters<typeof harness>[2] = {}) => {
    const plain = {
      id: "deps",
      layer: "L0" as const,
      phase: "install" as const,
      command: [NODE, "tools/install.mjs"],
    };
    return harness(
      {
        "src/a.ts": "export const a = 1;\n",
        "vendor/lint.mjs": LINT,
        "tools/install.mjs":
          'import { copyFileSync, mkdirSync } from "node:fs";\nmkdirSync("node_modules/lint-tool", { recursive: true });\ncopyFileSync("vendor/lint.mjs", "node_modules/lint-tool/lint.mjs");\n',
      },
      config([plain, explicitLint]),
      options,
    );
  };

  it("runs a tool hashed only after an install's scripts ran, marked after_scripts with a warning (reading 251)", async () => {
    const h = plainInstall();
    writeFile(h.repo, "src/a.ts", "export const a = 2; // TODO\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    expect(h.argvs.filter((a) => a.includes("tools/install.mjs")).length).toBeGreaterThan(0);
    expect(result(report, "deps").status).toBe("pass");
    // allowed (Lead decision 2026-10-16): the real linter ran and found the TODO, and the result
    // says its hash came after an install's scripts ran
    const lint = result(report, "lint");
    expect(lint).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: [], baseline: "after_scripts" },
    });
    expect(lint.findings[0]?.rule_id).toBe("no-todo");
    expect(lintRan(h.argvs)).toBe(true);
    // the warning is on the gate's own report, and the run's log names the install gate
    expect(lint.evidence.map((e) => e.ref)).toContainEqual(
      expect.stringMatching(/lint-tool\.log$/),
    );
    expect(evidenceLog(h.repo, "lint-tool.log")).toMatch(
      /^WARNING: .*install gate\(s\) deps ran their lifecycle scripts.*after_scripts/,
    );
    const log = evidenceLog(h.repo, "_tool-integrity.log");
    expect(log).toMatch(/deps have no scripts-free form/);
    expect(log).toMatch(/run marked after_scripts, with a warning/);
    expect(log).not.toMatch(/first found/);
  });

  it("still compares the workspace's tools from an after_scripts hash on (reading 251)", async () => {
    // the build gate runs a committed script (no tool VTC derives from its command) that edits
    // the installed linter after the hash: the lint gate fails as tampering though both were
    // hashed only after the install's scripts ran
    const touch = { id: "build", layer: "L0" as const, command: [NODE, "tools/touch.mjs"] };
    const h = harness(
      {
        "src/a.ts": "export const a = 1;\n",
        "vendor/lint.mjs": LINT,
        "tools/install.mjs":
          'import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";\nmkdirSync("node_modules/lint-tool", { recursive: true });\nmkdirSync("node_modules/.bin", { recursive: true });\ncopyFileSync("vendor/lint.mjs", "node_modules/lint-tool/lint.mjs");\nsymlinkSync("../lint-tool/lint.mjs", "node_modules/.bin/lint-tool");\n',
        "tools/touch.mjs":
          'import { appendFileSync } from "node:fs";\nappendFileSync("node_modules/lint-tool/lint.mjs", "// off\\n");\n',
      },
      config([
        { id: "deps", layer: "L0", phase: "install", command: [NODE, "tools/install.mjs"] },
        touch,
        {
          id: "lint",
          layer: "L1",
          command: [NODE, "tools/run-lint.mjs", REPORT, "{changed}"],
          report: { format: "json", path: REPORT },
        },
      ]),
    );
    writeFile(
      h.repo,
      "tools/run-lint.mjs",
      'import { spawnSync } from "node:child_process";\nprocess.exit(spawnSync("node_modules/.bin/lint-tool", process.argv.slice(2), { stdio: "inherit" }).status ?? 1);\n',
    );
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L0", "L1"] });
    expect(result(report, "build").status).toBe("pass");
    expect(result(report, "lint")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: {
        source: "project",
        baseline: "after_scripts",
        tampered: ["node_modules/lint-tool/lint.mjs"],
      },
    });
    expect(result(report, "lint").findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
  });

  it("keeps the configured order: a plain install gate runs after the scripts it needs", async () => {
    // The plain gate needs the dependency's postinstall output and writes into node_modules,
    // which a later run of the package manager's install would delete.
    const gen = {
      id: "generate",
      layer: "L0" as const,
      phase: "install" as const,
      command: [NODE, "tools/gen.mjs"],
    };
    const check = {
      id: "build",
      layer: "L0" as const,
      command: [NODE, "tools/check.mjs"],
      tool: { source: "project" as const, paths: ["node_modules/.prisma/**"] },
    };
    const files = {
      // the dependency's own install script builds it in its own directory (reading 252)
      "vendor/node_modules/native-dep/package.json": JSON.stringify({
        name: "native-dep",
        scripts: { postinstall: "node build.mjs" },
      }),
      "vendor/node_modules/native-dep/build.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync(".built", "native");\n',
      "tools/gen.mjs":
        'import { existsSync, mkdirSync, writeFileSync } from "node:fs";\nif (!existsSync("node_modules/native-dep/.built")) process.exit(3);\nmkdirSync("node_modules/.prisma", { recursive: true });\nwriteFileSync("node_modules/.prisma/client.js", "generated");\n',
      "tools/check.mjs":
        'import { existsSync } from "node:fs";\nprocess.exit(existsSync("node_modules/.prisma/client.js") ? 0 : 4);\n',
    };
    // the build gate's tool is found only after the plain gate ran; what the plain gate wrote
    // cannot be told from tampering, so every verify gate runs marked after_scripts (readings 251
    // and 252)
    const { h, npm } = setup([gen, check, explicitLint], files);
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L0", "L1"] });
    const order = h.argvs
      .filter((a) => a[0] === npm || a.includes("tools/gen.mjs"))
      .slice(0, 3)
      .map((a) => (a[0] === npm ? a.slice(1).join(" ") : "gen"));
    // the dependency's scripts run on their own (spine §5 reading 253)
    expect(order).toEqual(["ci --ignore-scripts", "rebuild native-dep", "gen"]);
    expect(report.results.map((r) => [r.gate_id, r.status])).toEqual([
      ["install", "pass"],
      ["generate", "pass"],
      ["build", "pass"],
      ["lint", "pass"],
    ]);
    expect(result(report, "lint").tool?.tampered).toEqual([]);
    expect(result(report, "lint").tool?.baseline).toBe("after_scripts");
    // the dependency that built itself is a warning, on every verify gate
    expect(result(report, "lint").tool?.self_rebuilt).toEqual([
      {
        package: "node_modules/native-dep",
        files: ["node_modules/native-dep/.built"],
        file_count: 1,
      },
    ]);
    // What the plain gate wrote is hashed once it ran, and the evidence says so.
    expect(result(report, "build").tool).toMatchObject({ tampered: [], baseline: "after_scripts" });
    const log = evidenceLog(h.repo, "_tool-integrity.log");
    expect(log).toMatch(/generate have no scripts-free form/);
    expect(log).toMatch(
      /the tools of gate\(s\) build were first found after those install gates ran/,
    );
  });

  it("runs a gate whose tool paths are stale or match nothing, and notes it: detail only (reading 252)", async () => {
    const stale = {
      id: "lint",
      layer: "L1" as const,
      command: ["node_modules/.bin/lint-tool", REPORT, "{changed}"],
      report: { format: "json" as const, path: REPORT },
      tool: { source: "project" as const, paths: ["node_modules/.pnpm/lint-tool@0.9.0/**"] },
    };
    const nothing = {
      ...explicitLint,
      id: "lint-nothing",
      tool: { source: "project" as const, paths: ["node_modules/not-installed/**"] },
    };
    const { h } = setup([stale, nothing]);
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    // the check is the whole checkout, which nothing changed: both run, and pass
    for (const id of ["lint", "lint-nothing"]) {
      expect(result(report, id)).toMatchObject({
        status: "pass",
        tool: { source: "project", tampered: [] },
      });
    }
    expect(lintRan(h.argvs)).toBe(true);
    expect(evidenceLog(h.repo, "_tool-integrity.log")).toMatch(
      /gate lint: its command runs node_modules\/\.bin\/lint-tool, node_modules\/lint-tool\/\*\*, which its tool paths in gates\.yml do not cover.*re-run vtc calibrate.*detail only/,
    );
  });

  /**
   * A run whose install gate is the fake `npm ci` and whose `check` gate runs `command` from `cwd`
   * with the fake npm and npx first on PATH (a runner is known by its bare name), and, when given,
   * a committed `postinstall.mjs`.
   */
  const viaPath = async (
    command: string[],
    files: Record<string, string>,
    postinstall?: string,
  ): Promise<{ report: GateReport; h: ReturnType<typeof harness> }> => {
    const { npm } = setup([]);
    const bin = join(npm, "..");
    const h = harness(
      { "vendor/lint.mjs": LINT, ...files },
      config([
        { id: "install", layer: "L0", phase: "install", command: [npm, "ci"] },
        {
          id: "check",
          layer: "L0",
          ...(files["packages/app/package.json"] === undefined ? {} : { cwd: "packages/app" }),
          command,
        },
      ]),
      {
        allow: [[NODE], [npm], [command[0] ?? ""]],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    if (postinstall !== undefined) writeFile(h.repo, "postinstall.mjs", postinstall);
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    return { report: await h.run({ head: commitAll(h.repo), layers: ["L0"] }), h };
  };

  it("fails a gate whose command resolves to an executable planted nearer its cwd after the hash", async () => {
    // The gate runs in a workspace package; at hash time `npx lint-tool` there is the root's bin.
    const files = { "packages/app/package.json": "{}\n", "packages/app/.lintrc": "strict\n" };
    const command = ["npx", "lint-tool", "out.json"];
    const clean = await viaPath(command, files);
    expect(result(clean.report, "check")).toMatchObject({ status: "pass", tool: { tampered: [] } });

    // A dependency's postinstall plants packages/app/node_modules/.bin/lint-tool: npx runs it.
    const plant = `import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
mkdirSync("packages/app/node_modules/.bin", { recursive: true });
writeFileSync("packages/app/evil.mjs", "#!/usr/bin/env node\\nprocess.exit(0);\\n", { mode: 0o755 });
symlinkSync("../../evil.mjs", "packages/app/node_modules/.bin/lint-tool");
`;
    const { report, h } = await viaPath(command, files, plant);
    const check = result(report, "check");
    expect(check).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: {
        source: "project",
        // the planted bin and the script it starts, both new in the checkout (reading 252)
        tampered: ["packages/app/evil.mjs", "packages/app/node_modules/.bin/lint-tool"],
      },
    });
    expect(check.findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
    expect(h.argvs.some((a) => a[0] === "npx")).toBe(false);
  });

  it("fails a gate as tampering when a postinstall rewrote the package script it runs (reading 252)", async () => {
    // The lint script ran the installed bin when the checkout was hashed; a postinstall rewrites
    // it. A changed file of the checkout's own is tampering: the gate never runs, neither script.
    const pkg = (lint: string): string => JSON.stringify({ name: "app", scripts: { lint } });
    const { report, h } = await viaPath(
      ["npm", "run", "lint"],
      {
        "package.json": pkg("lint-tool out.json"),
        // were it run, the gate would fail
        "evil.mjs": "process.exit(3);\n",
      },
      `import { writeFileSync } from "node:fs";\nwriteFileSync("package.json", ${JSON.stringify(pkg("node evil.mjs"))});\n`,
    );
    expect(result(report, "check")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: ["package.json"] },
    });
    expect(result(report, "check").findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
    expect(h.argvs.some((a) => a[0] === "npm" && a[1] === "run")).toBe(false);
  });

  /** A package `typecheck` script whose tool always finds an error (exit 1). */
  const typecheck = (script = "lint-tool out.json"): Record<string, string> => ({
    "package.json": JSON.stringify({ name: "app", scripts: { typecheck: script } }),
    "vendor/lint.mjs": "#!/usr/bin/env node\nprocess.exit(1);\n",
  });

  it("fails an L0 gate as tampering when an install script appended || true to its package script", async () => {
    const pkg = JSON.stringify({
      name: "app",
      scripts: { typecheck: "lint-tool out.json || true" },
    });
    const { report, h } = await viaPath(
      ["npm", "run", "typecheck"],
      typecheck(),
      `import { writeFileSync } from "node:fs";\nwriteFileSync("package.json", ${JSON.stringify(pkg)});\n`,
    );
    // a changed package.json is tampering (reading 252): the gate fails and never runs
    expect(result(report, "check")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: ["package.json"] },
    });
    expect(h.argvs.some((a) => a[0] === "npm" && a[1] === "run")).toBe(false);
  });

  it("fails an L0 gate as tampering when an install script planted an .npmrc script-shell", async () => {
    const plant = `import { writeFileSync } from "node:fs";
writeFileSync("x.sh", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
writeFileSync(".npmrc", "script-shell=./x.sh\\n");
`;
    const { report, h } = await viaPath(["npm", "run", "typecheck"], typecheck(), plant);
    expect(result(report, "check")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: [".npmrc", "x.sh"] },
    });
    expect(h.argvs.some((a) => a[0] === "npm" && a[1] === "run")).toBe(false);
  });

  it("fails a gate whose shim or run script would find a planted node in a .bin on its PATH (reading 249)", async () => {
    const derived = {
      id: "lint",
      layer: "L1" as const,
      command: ["node_modules/.bin/lint-tool", REPORT, "{changed}"],
      report: { format: "json" as const, path: REPORT },
    };
    const { h } = setup([derived], {
      // the second pass's script plants an interpreter beside the bins: no tool file changes
      "postinstall.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync("node_modules/.bin/node", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });\n',
    });
    writeFile(h.repo, "src/a.ts", "export const a = 2; // TODO\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    const lint = result(report, "lint");
    expect(lint).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { source: "project", tampered: ["node_modules/.bin/node"] },
    });
    expect(lint.findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
    expect(lintRan(h.argvs)).toBe(false);
  });

  it("hashes the lint config's plugins with a lint gate's tool even when gates.yml names none (reading 249)", async () => {
    const derived = {
      id: "lint",
      layer: "L1" as const,
      command: ["node_modules/.bin/lint-tool", REPORT, "{changed}"],
      report: { format: "json" as const, path: REPORT },
    };
    const files = {
      "package.json": JSON.stringify({ devDependencies: { "eslint-plugin-strict": "1.0.0" } }),
      "eslint.config.js": 'import globals from "globals";\nexport default [];\n',
      "vendor/node_modules/eslint-plugin-strict/package.json": '{"name":"eslint-plugin-strict"}',
      "vendor/node_modules/eslint-plugin-strict/index.js": "export const rules = { all: 1 };\n",
      "vendor/node_modules/globals/package.json": '{"name":"globals"}',
      "vendor/node_modules/globals/index.js": "export default {};\n",
    };
    const clean = setup([derived], files);
    writeFile(clean.h.repo, "src/a.ts", "export const a = 2;\n");
    const ok = await clean.h.run({ head: commitAll(clean.h.repo), layers: ["L1"] });
    expect(result(ok, "lint")).toMatchObject({ status: "pass", tool: { tampered: [] } });

    // an install script turns the plugin's rules off and edits what the config imports
    const { h } = setup([derived], {
      ...files,
      "postinstall.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync("node_modules/eslint-plugin-strict/index.js", "export const rules = {};\\n");\nwriteFileSync("node_modules/globals/index.js", "export default { x: 1 };\\n");\n',
    });
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    expect(result(report, "lint")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: {
        tampered: ["node_modules/eslint-plugin-strict/index.js", "node_modules/globals/index.js"],
      },
    });
  });

  it("fails a tool grown past the hash limits since the hash as tampering, not infrastructure", async () => {
    const { h } = setup([explicitLint], {
      // Sparse: past the byte limit, with nothing written.
      "postinstall.mjs": `import { closeSync, openSync, truncateSync } from "node:fs";\ncloseSync(openSync("node_modules/lint-tool/big.bin", "w"));\ntruncateSync("node_modules/lint-tool/big.bin", ${String(1024 ** 3 + 1)});\n`,
    });
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    expect(result(report, "lint")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: ["node_modules/lint-tool/big.bin"] },
    });
    expect(result(report, "lint").findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
  });
});

describe("H-14: a pinned tool runs from VTC's store", () => {
  it("reports the pinned binary SHA-256 the store verified the binary against", async () => {
    const pinned = "ab".repeat(32);
    const h = harness({ "src/a.ts": "export const a = 1;\n" }, config([leaksGate]), {
      scanners: (home) => ({ ...fakeScanners(home), pinnedBinarySha256: () => pinned }),
    });
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L4"] });
    expect(result(report, "secrets").tool).toEqual({
      source: "pinned",
      sha256: pinned,
      tampered: [],
    });
  });

  it("reports the SHA-256 of the store-verified binary that ran", async () => {
    const h = harness({ "src/a.ts": "export const a = 1;\n" }, config([leaksGate]));
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L4"] });
    const ran = h.argvs.find((a) => a.includes("--report-path"))?.[0] ?? "";
    const sha = createHash("sha256").update(readFileSync(ran)).digest("hex");
    expect(result(report, "secrets")).toMatchObject({
      status: "pass",
      tool: { source: "pinned", sha256: sha, tampered: [] },
    });
  });

  it("never runs a user-installed copy for a gate that names its pinned tool", async () => {
    // Checkov is the scanner a user may install where VTC pins no build (D-u): not when the gate
    // asks for the pinned tool.
    const bin = tempDir("vtc-path-");
    writeFile(
      bin,
      "checkov",
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const dir = process.argv[process.argv.indexOf("--output-file-path") + 1];
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/results_sarif.sarif", JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "checkov" } }, results: [] }] }));
`,
    );
    chmodSync(join(bin, "checkov"), 0o755);
    const iac = {
      id: "iac",
      layer: "L4" as const,
      command: [
        "checkov",
        "-d",
        ".",
        "--quiet",
        "-o",
        "sarif",
        "--output-file-path",
        ".vtc/state/gates/checkov",
      ],
      report: { format: "sarif" as const, path: ".vtc/state/gates/checkov/results_sarif.sarif" },
    };
    const options = {
      scanners: () => ({
        names: ["checkov"],
        ensure: (name: string) => Promise.reject(new ScannerUnavailableError(name, "darwin-arm64")),
      }),
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    };
    // Without a tool the user's own Checkov runs, as before.
    const own = harness({ "infra/main.tf": "resource {}\n" }, config([iac]), options);
    expect(result(await own.run({ head: own.base, layers: ["L4"] }), "iac").status).toBe("pass");
    const h = harness(
      { "infra/main.tf": "resource {}\n" },
      config([{ ...iac, tool: { source: "pinned", pin: "checkov" } }]),
      options,
    );
    const gate = result(await h.run({ head: h.base, layers: ["L4"] }), "iac");
    expect(gate).toMatchObject({ status: "error", failure_class: "infra" });
    expect(gate.tool).toBeUndefined();
    expect(h.argvs.some((a) => a[0]?.endsWith("/checkov") === true)).toBe(false);
  });

  it("does not run a gate whose command does not start with its pinned tool", async () => {
    const h = harness(
      {},
      config([{ ...leaksGate, tool: { source: "pinned", pin: "osv-scanner" } }]),
    );
    const report = await h.run({ head: commitAll(h.repo), layers: ["L4"] });
    const gate = result(report, "secrets");
    expect(gate).toMatchObject({ status: "error", failure_class: "infra" });
    expect(readFileSync(join(h.repo, gate.evidence[0]?.ref ?? ""), "utf8")).toMatch(
      /must start with osv-scanner/,
    );
  });
});

describe("H-14: the workspace's tools, whatever the gate command runs (reading 251)", () => {
  /** An installed linter in packages/web that passes, a root task runner, and their bins. */
  const WEB_LINT = "#!/usr/bin/env node\nprocess.exit(0);\n";
  const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name, ...extra });
  const workspace = (links: [string, string][]): Record<string, string> => ({
    "package.json": pkg("root", {
      scripts: { lint: "cd packages/web && ./node_modules/.bin/lint-tool" },
    }),
    "packages/web/package.json": pkg("web", {
      scripts: { lint: "lint-tool" },
      devDependencies: { "eslint-plugin-strict": "1.0.0" },
    }),
    "vendor/tree/packages/web/node_modules/lint-tool/package.json": pkg("lint-tool", {
      bin: { "lint-tool": "lint.mjs" },
    }),
    "vendor/tree/packages/web/node_modules/lint-tool/lint.mjs": WEB_LINT,
    "vendor/tree/packages/web/node_modules/eslint-plugin-strict/package.json":
      pkg("eslint-plugin-strict"),
    "vendor/tree/packages/web/node_modules/eslint-plugin-strict/index.js":
      "export const rules = { all: 1 };\n",
    "vendor/tree/node_modules/turbo/package.json": pkg("turbo", {
      bin: { turbo: "bin/turbo.mjs" },
    }),
    "vendor/tree/node_modules/turbo/bin/turbo.mjs": "#!/usr/bin/env node\nprocess.exit(0);\n",
    "vendor/links.json": JSON.stringify(links),
  });
  const LINKS: [string, string][] = [
    ["packages/web/node_modules/.bin/lint-tool", "../lint-tool/lint.mjs"],
    ["node_modules/.bin/turbo", "../turbo/bin/turbo.mjs"],
  ];

  /** One `lint` verify gate running `command` after the fake `npm ci`, with `postinstall`. */
  const run = async (
    command: string[],
    postinstall?: string,
    files: Record<string, string> = workspace(LINKS),
  ): Promise<{ report: GateReport; h: ReturnType<typeof harness> }> => {
    const { bin, npm } = fakePackageManagers();
    const h = harness(
      { "vendor/lint.mjs": LINT, "src/a.ts": "export const a = 1;\n", ...files },
      config([
        { id: "install", layer: "L0", phase: "install", command: [npm, "ci"] },
        { id: "lint", layer: "L0", command },
      ]),
      {
        allow: [[NODE], [npm], [command[0] ?? ""]],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    if (postinstall !== undefined) writeFile(h.repo, "postinstall.mjs", postinstall);
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    return { report: await h.run({ head: commitAll(h.repo), layers: ["L0"] }), h };
  };

  const editWebLinter = `import { appendFileSync } from "node:fs";
appendFileSync("packages/web/node_modules/lint-tool/lint.mjs", "process.exitCode = 0; // never fails\\n");
`;
  const plantWebNode = `import { writeFileSync } from "node:fs";
writeFileSync("packages/web/node_modules/.bin/node", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
`;
  const editWebPlugin = `import { writeFileSync } from "node:fs";
writeFileSync("packages/web/node_modules/eslint-plugin-strict/index.js", "export const rules = {};\\n");
`;

  const shapes: {
    name: string;
    command: string[];
    postinstall: string;
    tampered: string;
  }[] = [
    {
      // h14-task-runner-tool-unverified / h14-workspace-runner-tool-misattributed: the command
      // resolves to turbo; the linter turbo runs in packages/web is what an install script swaps
      name: "turbo run lint at the root",
      command: ["node_modules/.bin/turbo", "run", "lint"],
      postinstall: editWebLinter,
      tampered: "packages/web/node_modules/lint-tool/lint.mjs",
    },
    {
      // h14-bin-dir-interpreter-hijack: the .bin chain of packages/web, not the gate's cwd
      name: "pnpm -C packages/web run lint",
      command: ["pnpm", "-C", "packages/web", "run", "lint"],
      postinstall: plantWebNode,
      tampered: "packages/web/node_modules/.bin/node",
    },
    {
      // h14-runtime-derived-tool-misses-lint-plugins: a plugin of packages/web's lint config
      name: "npm --prefix packages/web run lint",
      command: ["npm", "--prefix", "packages/web", "run", "lint"],
      postinstall: editWebPlugin,
      tampered: "packages/web/node_modules/eslint-plugin-strict/index.js",
    },
    {
      // a root script that changes directory into the package: no tool derived from it at all
      name: "a root script that cds into a package",
      command: ["npm", "run", "lint"],
      postinstall: editWebLinter,
      tampered: "packages/web/node_modules/lint-tool/lint.mjs",
    },
  ];

  it.each(shapes)(
    "$name: passes untouched, and fails when an install script swaps the tool",
    async (shape) => {
      const clean = await run(shape.command);
      expect(result(clean.report, "lint")).toMatchObject({
        status: "pass",
        tool: {
          source: "project",
          workspace_sha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
          tampered: [],
        },
      });

      const { report, h } = await run(shape.command, shape.postinstall);
      const lint = result(report, "lint");
      expect(lint).toMatchObject({ status: "fail", failure_class: "product" });
      expect(lint.tool?.tampered).toContain(shape.tampered);
      expect(lint.findings).toHaveLength(1);
      expect(lint.findings[0]).toMatchObject({
        rule_id: TOOL_TAMPER_RULE_ID,
        category: "security",
      });
      expect(report.verdict).toBe("fail");
      // the gate never ran
      expect(h.argvs.some((a) => a.join(" ") === shape.command.join(" "))).toBe(false);
    },
  );

  it("keeps the command's own tool as detail: turbo's hash beside the workspace's", async () => {
    const { report } = await run(["node_modules/.bin/turbo", "run", "lint"]);
    const tool = result(report, "lint").tool;
    expect(tool?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(tool?.sha256).not.toBe(tool?.workspace_sha256);
  });

  it("fails a gate whose .bin shim would run a swapped $basedir/node", async () => {
    // packages/web's bin is a pnpm-style shim that prefers the node beside it
    const shim = `#!/bin/sh
basedir=$(dirname "$0")
if [ -x "$basedir/node" ]; then exec "$basedir/node" "$basedir/../lint-tool/lint.mjs" "$@"; fi
exec node "$basedir/../lint-tool/lint.mjs" "$@"
`;
    const files = {
      ...workspace([["node_modules/.bin/turbo", "../turbo/bin/turbo.mjs"]]),
      "vendor/tree/packages/web/node_modules/.bin/lint-tool": shim,
      "vendor/tree/packages/web/node_modules/.bin/node": '#!/bin/sh\nexec node "$@"\n',
    };
    const swap = `import { writeFileSync } from "node:fs";
writeFileSync("packages/web/node_modules/.bin/node", "#!/bin/sh\\nexit 0\\n");
`;
    const clean = await run(["node_modules/.bin/turbo", "run", "lint"], undefined, files);
    expect(result(clean.report, "lint")).toMatchObject({ status: "pass", tool: { tampered: [] } });
    const { report } = await run(["node_modules/.bin/turbo", "run", "lint"], swap, files);
    expect(result(report, "lint")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { tampered: ["packages/web/node_modules/.bin/node"] },
    });
  });
});

describe("H-14: the whole checkout, diffed (reading 252; the round-7 findings)", () => {
  const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name, version: "1.0.0", ...extra });
  const PASS = "#!/usr/bin/env node\nprocess.exit(0);\n";
  const STORE = "node_modules/.pnpm";
  const VITEST = `${STORE}/vitest@1.0.0/node_modules/vitest`;
  const EXPECT = `${STORE}/@vitest+expect@1.0.0/node_modules/@vitest/expect`;
  const SITE = ".venv/lib/python3.12/site-packages";

  /**
   * A pnpm-layout monorepo the fake `npm ci` lays out: vitest in the virtual store with its
   * dependency @vitest/expect, turbo at the root, packages/app with no bin of its own,
   * packages/web's jest with ts-jest and a babel preset, and a virtual environment with pytest.
   */
  const monorepo = (): Record<string, string> => ({
    "package.json": pkg("root", { scripts: { test: "turbo run test" } }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    Makefile: "test:\n\t.venv/bin/pytest\n",
    "packages/app/package.json": pkg("app", { scripts: { test: "vitest run" } }),
    "packages/web/package.json": pkg("web", {
      scripts: { test: "jest" },
      jest: { preset: "ts-jest" },
    }),
    "packages/web/babel.config.js": "module.exports = { presets: ['@acme/babel-preset'] };\n",
    [`vendor/tree/${VITEST}/package.json`]: pkg("vitest", {
      dependencies: { "@vitest/expect": "1" },
    }),
    [`vendor/tree/${VITEST}/vitest.mjs`]: PASS,
    [`vendor/tree/${EXPECT}/package.json`]: pkg("@vitest/expect"),
    [`vendor/tree/${EXPECT}/index.js`]:
      "export const expect = (v) => ({ toBe: (w) => { if (v !== w) throw new Error(); } });\n",
    "vendor/tree/node_modules/turbo/package.json": pkg("turbo", {
      bin: { turbo: "bin/turbo.mjs" },
    }),
    "vendor/tree/node_modules/turbo/bin/turbo.mjs": PASS,
    "vendor/tree/packages/web/node_modules/ts-jest/package.json": pkg("ts-jest"),
    "vendor/tree/packages/web/node_modules/ts-jest/jest-preset.js":
      "module.exports = { transform: {} };\n",
    "vendor/tree/packages/web/node_modules/@acme/babel-preset/package.json":
      pkg("@acme/babel-preset"),
    "vendor/tree/packages/web/node_modules/@acme/babel-preset/index.js":
      "module.exports = () => ({ plugins: [] });\n",
    "vendor/tree/.venv/pyvenv.cfg": "home = /usr/bin\n",
    "vendor/tree/.venv/bin/pytest": "#!/bin/sh\nexit 0\n",
    [`vendor/tree/${SITE}/_pytest/assertion/rewrite.py`]: "def rewrite(): ...\n",
    "vendor/links.json": JSON.stringify([
      [
        `${STORE}/vitest@1.0.0/node_modules/@vitest/expect`,
        "../../../@vitest+expect@1.0.0/node_modules/@vitest/expect",
      ],
      ["node_modules/vitest", ".pnpm/vitest@1.0.0/node_modules/vitest"],
      ["node_modules/.bin/vitest", "../vitest/vitest.mjs"],
      ["node_modules/.bin/turbo", "../turbo/bin/turbo.mjs"],
    ]),
  });

  /** One `check` verify gate running `command` after the fake `npm ci`, with `postinstall`. */
  const run = async (
    command: string[],
    postinstall?: string,
    files: Record<string, string> = monorepo(),
    layer: "L0" | "L2" = "L0",
  ): Promise<{ report: GateReport; h: ReturnType<typeof harness> }> => {
    const { bin, npm } = fakePackageManagers();
    // a `make` (and `tox`) that passes: the tool they would run is what the tests swap
    for (const name of ["make", "tox"]) {
      writeFile(bin, name, "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    const h = harness(
      { "vendor/lint.mjs": LINT, "src/a.ts": "export const a = 1;\n", ...files },
      config([
        { id: "install", layer: "L0", phase: "install", command: [npm, "ci"] },
        { id: "check", layer, command },
      ]),
      {
        allow: [[NODE], [npm], [command[0] ?? ""]],
        env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
      },
    );
    if (postinstall !== undefined) writeFile(h.repo, "postinstall.mjs", postinstall);
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    return { report: await h.run({ head: commitAll(h.repo), layers: [layer] }), h };
  };

  /** A postinstall that writes each `[path, text]`, creating directories on the way. */
  const writes = (files: [string, string][]): string =>
    `import { mkdirSync, writeFileSync } from "node:fs";\nimport { dirname } from "node:path";\n${files
      .map(
        ([path, text]) =>
          `mkdirSync(dirname(${JSON.stringify(path)}), { recursive: true });\nwriteFileSync(${JSON.stringify(path)}, ${JSON.stringify(text)}, { mode: 0o755 });`,
      )
      .join("\n")}\n`;

  const shapes: { name: string; command: string[]; postinstall: string; tampered: string[] }[] = [
    {
      name: "h14-task-runner-tool-unverified: a transitive @vitest/expect, under turbo run test",
      command: ["node_modules/.bin/turbo", "run", "test"],
      postinstall: writes([
        [`${EXPECT}/index.js`, "export const expect = () => ({ toBe() {} });\n"],
      ]),
      tampered: [`${EXPECT}/index.js`],
    },
    {
      name: "h14-task-runner-tool-unverified: a transitive @vitest/expect, under pnpm -r test",
      command: ["pnpm", "-r", "test"],
      postinstall: writes([
        [`${EXPECT}/index.js`, "export const expect = () => ({ toBe() {} });\n"],
      ]),
      tampered: [`${EXPECT}/index.js`],
    },
    {
      name: "h14-bin-dir-interpreter-hijack: a .bin directory planted in packages/app, under pnpm --filter app test",
      command: ["pnpm", "--filter", "app", "test"],
      postinstall: writes([["packages/app/node_modules/.bin/vitest", "#!/bin/sh\nexit 0\n"]]),
      tampered: ["packages/app/node_modules/.bin/vitest"],
    },
    {
      name: "h14-runtime-derived-tool-misses-lint-plugins: a patched ts-jest and babel preset, under turbo",
      command: ["node_modules/.bin/turbo", "run", "test"],
      postinstall: writes([
        [
          "packages/web/node_modules/ts-jest/jest-preset.js",
          "module.exports = { testMatch: [] };\n",
        ],
        [
          "packages/web/node_modules/@acme/babel-preset/index.js",
          "module.exports = () => ({ plugins: ['strip-expect'] });\n",
        ],
      ]),
      tampered: [
        "packages/web/node_modules/@acme/babel-preset/index.js",
        "packages/web/node_modules/ts-jest/jest-preset.js",
      ],
    },
    {
      name: "h14-task-runner-tool-unverified (Python): a patched _pytest in the venv, under make test",
      command: ["make", "test"],
      postinstall: writes([
        [`${SITE}/_pytest/assertion/rewrite.py`, "def rewrite(): return None\n"],
      ]),
      tampered: [`${SITE}/_pytest/assertion/rewrite.py`],
    },
    {
      name: "h14-task-runner-tool-unverified (Python): a planted usercustomize in the venv, under tox",
      command: ["tox"],
      postinstall: writes([[`${SITE}/usercustomize.py`, "import builtins\n"]]),
      tampered: [`${SITE}/usercustomize.py`],
    },
  ];

  it.each(shapes)(
    "$name: passes untouched, and fails when an install script swaps it",
    async (shape) => {
      const clean = await run(shape.command);
      expect(result(clean.report, "check")).toMatchObject({
        status: "pass",
        tool: { source: "project", tampered: [] },
      });
      expect(clean.h.argvs.some((a) => a.join(" ") === shape.command.join(" "))).toBe(true);

      const { report, h } = await run(shape.command, shape.postinstall);
      const check = result(report, "check");
      expect(check).toMatchObject({
        status: "fail",
        failure_class: "product",
        tool: { source: "project", tampered: shape.tampered },
      });
      expect(check.findings).toHaveLength(1);
      expect(check.findings[0]).toMatchObject({
        rule_id: TOOL_TAMPER_RULE_ID,
        category: "security",
      });
      // the gate never ran
      expect(h.argvs.some((a) => a.join(" ") === shape.command.join(" "))).toBe(false);
    },
  );

  it("h14-run-home-config-injection: a $HOME/.npmrc an install script writes never reaches a verify gate", async () => {
    // a typecheck whose tool always finds an error; the install script's user-level npmrc would
    // make every Node process exit 0 (node-options) and every script a no-op (script-shell)
    const files = {
      "package.json": pkg("app", { scripts: { typecheck: "lint-tool out.json" } }),
      "vendor/lint.mjs": "#!/usr/bin/env node\nprocess.exit(1);\n",
    };
    const inject = `import { writeFileSync } from "node:fs";
import { join } from "node:path";
const home = process.env.HOME;
writeFileSync(join(home, "p.cjs"), "const exit = process.exit; process.exit = () => exit(0);\\n");
writeFileSync(join(home, "sh"), "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
writeFileSync(join(home, ".npmrc"), "node-options=--require=" + join(home, "p.cjs") + "\\nscript-shell=" + join(home, "sh") + "\\n");
writeFileSync(join(home, ".yarnrc.yml"), "yarnPath: " + join(home, "sh") + "\\n");
writeFileSync(join(home, ".bunfig.toml"), "preload = [\\"" + join(home, "p.cjs") + "\\"]\\n");
`;
    const { report, h } = await run(["npm", "run", "typecheck"], inject, files);
    // the real tool ran, without the injected config, and its error fails the gate
    expect(result(report, "check")).toMatchObject({ status: "fail", tool: { tampered: [] } });
    expect(h.argvs.some((a) => a[0] === "npm" && a[1] === "run")).toBe(true);
    const install = h.specs.find((s) => s.phase === "install");
    const verify = h.specs.find((s) => s.phase === "verify");
    expect(verify?.home).toBeDefined();
    expect(verify?.home).not.toBe(install?.home);
  });

  /**
   * The fake npm's tree plus esbuild, whose own postinstall writes each `[path, text]` (from the
   * checkout's root): rebuilding its own binary, and whatever else a test has it write.
   */
  const esbuild = (postinstall: [string, string][]): Record<string, string> => ({
    "vendor/node_modules/esbuild/package.json": pkg("esbuild", {
      scripts: { postinstall: "cd ../.. && node esbuild-install.mjs" },
      bin: { esbuild: "bin/esbuild" },
    }),
    "vendor/node_modules/esbuild/bin/esbuild": "#!/usr/bin/env node\n// the JS fallback\n",
    "esbuild-install.mjs": writes(postinstall),
  });

  it("lets an esbuild-style package rebuild itself in its own directory, with a warning", async () => {
    const { h } = setup(
      [explicitLint],
      esbuild([
        ["node_modules/esbuild/bin/esbuild", "\u007fELF native"],
        ["node_modules/esbuild/esbuild.node", "native"],
      ]),
    );
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    const lint = result(report, "lint");
    expect(lint).toMatchObject({ status: "pass", tool: { source: "project", tampered: [] } });
    expect(lint.tool?.self_rebuilt).toEqual([
      {
        package: "node_modules/esbuild",
        files: ["node_modules/esbuild/bin/esbuild", "node_modules/esbuild/esbuild.node"],
        file_count: 2,
      },
    ]);
    expect(lintRan(h.argvs)).toBe(true);
    expect(lint.evidence.map((e) => e.ref)).toContainEqual(
      expect.stringMatching(/lint-tool\.log$/),
    );
    expect(evidenceLog(h.repo, "lint-tool.log")).toMatch(
      /^WARNING: these packages' own install scripts changed files in their own directory[^]*node_modules\/esbuild: node_modules\/esbuild\/bin\/esbuild, node_modules\/esbuild\/esbuild\.node/,
    );
  });

  it("fails every gate when that same package also writes into another package", async () => {
    const { h } = setup(
      [explicitLint],
      esbuild([
        ["node_modules/esbuild/bin/esbuild", "\u007fELF native"],
        ["node_modules/lint-tool/lint.mjs", "#!/usr/bin/env node\nprocess.exit(0);\n"],
      ]),
    );
    writeFile(h.repo, "src/a.ts", "export const a = 2; // TODO\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    const lint = result(report, "lint");
    expect(lint).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: {
        tampered: ["node_modules/lint-tool/lint.mjs"],
        self_rebuilt: [
          {
            package: "node_modules/esbuild",
            files: ["node_modules/esbuild/bin/esbuild"],
            file_count: 1,
          },
        ],
      },
    });
    expect(lint.findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
    expect(lintRan(h.argvs)).toBe(false);
  });
});

describe("H-14: the round-8 findings (h14-open2, spine §5 reading 253), end to end", () => {
  const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ name, version: "1.0.0", ...extra });

  /** Package managers and a `go` that fetch into the run's caches, on PATH and allowed. */
  const tools = (): { bin: string; npm: string; bun: string; go: string } => {
    const { bin, npm } = fakePackageManagers();
    // a fake bun: the fake npm's `ci` as `bun install`, `--force` running the scripts again
    const bun = join(bin, "bun");
    writeFile(
      bin,
      "bun",
      FAKE_NPM.replace(
        "let args = process.argv.slice(2);",
        'let args = process.argv.slice(2).map((a) => (a === "install" ? "ci" : a)).filter((a) => a !== "--force");',
      ),
    );
    chmodSync(bun, 0o755);
    // a fake go: `go mod download` extracts an assertion library into GOMODCACHE, as Go does
    const go = join(bin, "go");
    writeFile(
      bin,
      "go",
      `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const dir = process.env.GOMODCACHE + "/example.com/assert@v1.0.0";
mkdirSync(dir, { recursive: true });
writeFileSync(dir + "/assert.go", "package assert\\nfunc Equal(a, b any) bool { return a == b }\\n");
`,
    );
    chmodSync(go, 0o755);
    for (const name of ["make"]) {
      writeFile(bin, name, "#!/bin/sh\nexit 0\n");
      chmodSync(join(bin, name), 0o755);
    }
    return { bin, npm, bun, go };
  };

  /** The run of `install` gates then one verify gate (`check`, L0) running `command`. */
  const run = async (
    install: string[][],
    command: string[],
    files: Record<string, string>,
  ): Promise<{
    report: GateReport;
    h: ReturnType<typeof harness>;
    t: ReturnType<typeof tools>;
  }> => {
    const t = tools();
    const argv = install.map((a) => a.map((w) => (w in t ? t[w as keyof typeof t] : w)));
    const h = harness(
      { "vendor/lint.mjs": LINT, "src/a.ts": "export const a = 1;\n", ...files },
      config([
        ...argv.map((a, i) => ({
          id: `install-${String(i + 1)}`,
          layer: "L0" as const,
          phase: "install" as const,
          command: a,
        })),
        { id: "check", layer: "L0", command },
      ]),
      {
        allow: [[NODE], [command[0] ?? ""], ...argv.map((a) => [a[0] ?? ""])],
        env: { ...process.env, PATH: `${t.bin}:${process.env.PATH ?? ""}` },
      },
    );
    unlock.push(h.repo);
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    return { report: await h.run({ head: commitAll(h.repo), layers: ["L0"] }), h, t };
  };

  const tamperedRun = (report: GateReport, h: ReturnType<typeof harness>, paths: string[]) => {
    const check = result(report, "check");
    expect(check).toMatchObject({
      status: "fail",
      failure_class: "product",
      tool: { source: "project", tampered: paths },
    });
    expect(check.findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
    expect(h.argvs.some((a) => a[0] === "make")).toBe(false);
  };

  it.skipIf(process.getuid?.() === 0)(
    "h14-unlistable-dir-hidden-from-tree: a .bin planted in packages/app and made execute-only, under pnpm --filter app test",
    async () => {
      const files = {
        "package.json": pkg("root"),
        "packages/app/package.json": pkg("app", { scripts: { test: "vitest run" } }),
        "vendor/tree/packages/app/node_modules/dep/package.json": pkg("dep"),
        "postinstall.mjs": `import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("packages/app/node_modules/.bin", { recursive: true });
writeFileSync("packages/app/node_modules/.bin/vitest", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
chmodSync("packages/app/node_modules/.bin", 0o111);
`,
      };
      const { report, h } = await run([["npm", "ci"]], ["make", "test"], files);
      tamperedRun(report, h, ["packages/app/node_modules/.bin"]);
    },
  );

  it.skipIf(process.getuid?.() === 0)(
    "h14-unlistable-dir-hidden-from-tree: a directory the baseline cannot list runs no verify gate (infra)",
    async () => {
      const files = {
        "package.json": pkg("root"),
        "tools/lock.mjs": `import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
mkdirSync("generated/bin", { recursive: true });
writeFileSync("generated/bin/tool", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
chmodSync("generated/bin", 0o111);
`,
      };
      const { report, h } = await run(
        [
          [NODE, "tools/lock.mjs"],
          ["npm", "ci"],
        ],
        ["make", "test"],
        files,
      );
      expect(result(report, "check")).toMatchObject({ status: "error", failure_class: "infra" });
      expect(h.argvs.some((a) => a[0] === "make")).toBe(false);
    },
  );

  /** esbuild with its JavaScript API and a postinstall that rebuilds its own binary. */
  const ESBUILD = {
    "vendor/node_modules/esbuild/package.json": pkg("esbuild", {
      scripts: { postinstall: "node install.mjs" },
      bin: { esbuild: "bin/esbuild" },
    }),
    "vendor/node_modules/esbuild/install.mjs":
      'import { writeFileSync } from "node:fs";\nwriteFileSync("bin/esbuild", "\\u007fELF native");\n',
    "vendor/node_modules/esbuild/bin/esbuild": "#!/usr/bin/env node\n// the JS fallback\n",
    "vendor/node_modules/esbuild/lib/main.js": "export const transform = (code) => code;\n",
  };

  it("h14-self-rebuild-allowance-not-attributed-to-writer: the root postinstall rewriting esbuild's lib/main.js fails", async () => {
    const files = {
      ...ESBUILD,
      "package.json": pkg("root", { scripts: { postinstall: "node root-postinstall.mjs" } }),
      "root-postinstall.mjs": `import { writeFileSync } from "node:fs";
writeFileSync("node_modules/esbuild/lib/main.js", "export const transform = (code) => code.replace(/expect\\(/g, 'void (');\\n");
`,
    };
    const { report, h, t } = await run([["npm", "ci"]], ["make", "test"], files);
    tamperedRun(report, h, ["node_modules/esbuild/lib/main.js"]);
    // esbuild's own rebuild is still its own, and each writer ran on its own
    expect(result(report, "check").tool?.self_rebuilt).toEqual([
      {
        package: "node_modules/esbuild",
        files: ["node_modules/esbuild/bin/esbuild"],
        file_count: 1,
      },
    ]);
    const npm = h.argvs.filter((a) => a[0] === t.npm).map((a) => a.slice(1).join(" "));
    expect(npm.slice(0, 3)).toEqual([
      "ci --ignore-scripts",
      "rebuild esbuild",
      "run --ignore-scripts postinstall",
    ]);
  });

  it("h14-self-rebuild-allowance-not-attributed-to-writer: esbuild's own rebuild alone passes", async () => {
    const { report } = await run([["npm", "ci"]], ["make", "test"], {
      ...ESBUILD,
      "package.json": pkg("root"),
    });
    expect(result(report, "check")).toMatchObject({ status: "pass", tool: { tampered: [] } });
  });

  it("h14-self-rebuild-allowance-not-attributed-to-writer: Bun's scripts pass, run all at once, allows no rebuild", async () => {
    const { report, h } = await run([["bun", "install"]], ["make", "test"], {
      ...ESBUILD,
      "package.json": pkg("root"),
    });
    tamperedRun(report, h, ["node_modules/esbuild/bin/esbuild"]);
    expect(result(report, "check").tool?.baseline).toBe("after_scripts");
    expect(result(report, "check").tool?.self_rebuilt).toBeUndefined();
    expect(evidenceLog(h.repo, "_tool-integrity-install.log")).toMatch(
      /install gate\(s\) install-1 ran their lifecycle scripts all at once/,
    );
  });

  it("h14-shared-download-cache-unhashed: a postinstall patching a Go assertion library in GOMODCACHE fails", async () => {
    const files = {
      "package.json": pkg("root"),
      "postinstall.mjs": `import { writeFileSync } from "node:fs";
writeFileSync(process.env.GOMODCACHE + "/example.com/assert@v1.0.0/assert.go", "package assert\\nfunc Equal(a, b any) bool { return true }\\n");
`,
    };
    const { report, h } = await run(
      [
        ["go", "mod", "download"],
        ["npm", "ci"],
      ],
      ["make", "test"],
      files,
    );
    tamperedRun(report, h, [".vtc-deps/go-mod/example.com/assert@v1.0.0/assert.go"]);
  });

  it("h14-shared-download-cache-unhashed: an untouched module cache passes", async () => {
    const { report } = await run(
      [
        ["go", "mod", "download"],
        ["npm", "ci"],
      ],
      ["make", "test"],
      { "package.json": pkg("root") },
    );
    expect(result(report, "check")).toMatchObject({ status: "pass", tool: { tampered: [] } });
  });

  it("h14-links-out-of-checkout-not-followed: a package the scripts-free install linked from a store in the install home runs no verify gate", async () => {
    // the link is in the baseline; a later install script can rewrite what it points to
    const files = {
      "package.json": pkg("root"),
      "vendor/home-store/lint-core/package.json": pkg("lint-core"),
      "vendor/home-store/lint-core/index.js": "export const check = (v) => v;\n",
      "postinstall.mjs": `import { writeFileSync } from "node:fs";
import { join } from "node:path";
writeFileSync(join(process.env.HOME, "store/lint-core/index.js"), "export const check = () => true;\\n");
`,
    };
    const { report, h } = await run([["npm", "ci"]], ["make", "test"], files);
    expect(result(report, "check")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(h.argvs.some((a) => a[0] === "make")).toBe(false);
  });

  it("h14-links-out-of-checkout-not-followed: the root postinstall adding a pnpm-workspace.yaml fails", async () => {
    const files = {
      "package.json": pkg("root", { scripts: { postinstall: "node root-postinstall.mjs" } }),
      "root-postinstall.mjs": `import { writeFileSync } from "node:fs";
writeFileSync("pnpm-workspace.yaml", "enableGlobalVirtualStore: true\\n");
writeFileSync("dist.js", "built");
`,
    };
    const { report, h } = await run([["npm", "ci"]], ["make", "test"], files);
    tamperedRun(report, h, ["pnpm-workspace.yaml"]);
    expect(result(report, "check").tool?.self_rebuilt).toEqual([
      { package: ".", files: ["dist.js"], file_count: 1 },
    ]);
  });
});
