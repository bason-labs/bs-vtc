/**
 * Check tools that install scripts cannot replace (H-14; spine §5 readings 80(c) and 238), end to
 * end through the Gate Runner on real git checkouts: the scripts-free install first, the hash of
 * each check gate's `project` tool, the install with its scripts, the re-hash just before the
 * gate, and a pinned tool run from the store.
 */
import { createHash } from "node:crypto";
import { chmodSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TOOL_TAMPER_RULE_ID, type GateReport, type GateResult } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { ScannerUnavailableError } from "../../src/gates/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import { commitAll, config, fakeScanners, harness, leaksGate, NODE, TOOLS } from "./fixture.js";

afterEach(cleanupDirs);

/**
 * A fake npm: `ci` installs the committed `vendor/lint.mjs` as the package `lint-tool` (with a
 * `.bin` link) and, unless `--ignore-scripts`, runs the committed `postinstall.mjs` like a
 * dependency's lifecycle script would.
 */
const FAKE_NPM = `#!/usr/bin/env node
const { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] !== "ci") process.exit(2);
rmSync("node_modules", { recursive: true, force: true });
mkdirSync("node_modules/lint-tool", { recursive: true });
copyFileSync("vendor/lint.mjs", "node_modules/lint-tool/lint.mjs");
chmodSync("node_modules/lint-tool/lint.mjs", 0o755);
writeFileSync("node_modules/lint-tool/package.json", JSON.stringify({ name: "lint-tool", bin: { "lint-tool": "lint.mjs" } }));
mkdirSync("node_modules/.bin", { recursive: true });
symlinkSync("../lint-tool/lint.mjs", "node_modules/.bin/lint-tool");
if (!args.includes("--ignore-scripts") && existsSync("postinstall.mjs")) {
  const r = spawnSync(process.execPath, ["postinstall.mjs"], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}
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

const setup = (gates: Parameters<typeof config>[0], files: Record<string, string> = {}) => {
  const bin = tempDir("vtc-fake-pm-");
  const npm = join(bin, "npm");
  writeFile(bin, "npm", FAKE_NPM);
  chmodSync(npm, 0o755);
  const npx = join(bin, "npx");
  writeFile(bin, "npx", FAKE_NPX);
  chmodSync(npx, 0o755);
  const install = {
    id: "install",
    layer: "L0" as const,
    phase: "install" as const,
    command: [npm, "ci"],
  };
  const h = harness(
    { "vendor/lint.mjs": LINT, "src/a.ts": "export const a = 1;\n", ...files },
    config([install, ...gates]),
    { allow: [[NODE], [npm], [npx], ["node_modules/.bin/lint-tool"]] },
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
    // The build gate runs a committed script with the node on PATH: no tool VTC verifies.
    expect(evidenceLog(h.repo, "_tool-integrity.log")).toMatch(
      /gate\(s\) build run no tool VTC verifies/,
    );

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

  it("runs a leading install gate with no scripts-free form first, says so, and hashes after it", async () => {
    const plain = {
      id: "deps",
      layer: "L0" as const,
      phase: "install" as const,
      command: [NODE, "tools/install.mjs"],
    };
    const h = harness(
      {
        "src/a.ts": "export const a = 1;\n",
        "vendor/lint.mjs": LINT,
        "tools/install.mjs":
          'import { copyFileSync, mkdirSync } from "node:fs";\nmkdirSync("node_modules/lint-tool", { recursive: true });\ncopyFileSync("vendor/lint.mjs", "node_modules/lint-tool/lint.mjs");\n',
      },
      config([plain, explicitLint]),
    );
    writeFile(h.repo, "src/a.ts", "export const a = 2; // TODO\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    expect(h.argvs.filter((a) => a.includes("tools/install.mjs")).length).toBeGreaterThan(0);
    expect(result(report, "deps").status).toBe("pass");
    expect(result(report, "lint")).toMatchObject({ status: "fail", tool: { tampered: [] } });
    const log = evidenceLog(h.repo, "_tool-integrity.log");
    expect(log).toMatch(/deps have no scripts-free form/);
    expect(log).not.toMatch(/first found/);
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
    const { h, npm } = setup([gen, check, explicitLint], {
      "postinstall.mjs":
        'import { writeFileSync } from "node:fs";\nwriteFileSync("node_modules/.built", "native");\n',
      "tools/gen.mjs":
        'import { existsSync, mkdirSync, writeFileSync } from "node:fs";\nif (!existsSync("node_modules/.built")) process.exit(3);\nmkdirSync("node_modules/.prisma", { recursive: true });\nwriteFileSync("node_modules/.prisma/client.js", "generated");\n',
      "tools/check.mjs":
        'import { existsSync } from "node:fs";\nprocess.exit(existsSync("node_modules/.prisma/client.js") ? 0 : 4);\n',
    });
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L0", "L1"] });
    const order = h.argvs
      .filter((a) => a[0] === npm || a.includes("tools/gen.mjs"))
      .slice(0, 3)
      .map((a) => (a[0] === npm ? a.slice(1).join(" ") : "gen"));
    expect(order).toEqual(["ci --ignore-scripts", "ci", "gen"]);
    expect(report.results.map((r) => [r.gate_id, r.status])).toEqual([
      ["install", "pass"],
      ["generate", "pass"],
      ["build", "pass"],
      ["lint", "pass"],
    ]);
    expect(result(report, "lint").tool?.tampered).toEqual([]);
    // What the plain gate wrote is hashed once it ran, and the evidence says so.
    expect(result(report, "build").tool?.tampered).toEqual([]);
    const log = evidenceLog(h.repo, "_tool-integrity.log");
    expect(log).toMatch(/generate have no scripts-free form/);
    expect(log).toMatch(
      /the tools of gate\(s\) build were first found after those install gates ran/,
    );
  });

  it("does not run a gate whose tool paths are stale or match nothing", async () => {
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
    for (const id of ["lint", "lint-nothing"]) {
      expect(result(report, id)).toMatchObject({ status: "error", failure_class: "infra" });
    }
    expect(evidenceLog(h.repo, "lint.log")).toMatch(
      /runs node_modules\/\.bin\/lint-tool, node_modules\/lint-tool\/\*\*, which its tool paths in gates\.yml do not cover.*re-run vtc calibrate/,
    );
    expect(evidenceLog(h.repo, "lint-nothing.log")).toMatch(
      /match no file in the checkout; re-run vtc calibrate/,
    );
    expect(lintRan(h.argvs)).toBe(false);
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
      tool: { source: "project", tampered: ["packages/app/node_modules/.bin/lint-tool"] },
    });
    expect(check.findings[0]?.rule_id).toBe(TOOL_TAMPER_RULE_ID);
    expect(h.argvs.some((a) => a[0] === "npx")).toBe(false);
  });

  it("does not run a gate whose package script no longer runs the hashed tool", async () => {
    // The lint script ran the installed bin when the tool was hashed; a postinstall rewrites it.
    const pkg = (lint: string): string => JSON.stringify({ name: "app", scripts: { lint } });
    const { report, h } = await viaPath(
      ["npm", "run", "lint"],
      { "package.json": pkg("lint-tool out.json") },
      `import { writeFileSync } from "node:fs";\nwriteFileSync("package.json", ${JSON.stringify(pkg("node evil.mjs"))});\n`,
    );
    expect(result(report, "check")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(evidenceLog(h.repo, "check.log")).toMatch(
      /no longer runs the tool hashed after the scripts-free install \(node_modules\/\.bin\/lint-tool, node_modules\/lint-tool\/\*\*\)/,
    );
    expect(h.argvs.some((a) => a[0] === "npm" && a[1] === "run")).toBe(false);
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
