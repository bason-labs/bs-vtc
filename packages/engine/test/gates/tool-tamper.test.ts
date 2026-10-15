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
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import { commitAll, config, harness, leaksGate, NODE, TOOLS } from "./fixture.js";

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

const LINT = `#!/usr/bin/env node\n${TOOLS["tools/fake-lint.mjs"] ?? ""}`;
const REPORT = ".vtc/state/gates/lint.json";

const setup = (gates: Parameters<typeof config>[0], files: Record<string, string> = {}) => {
  const bin = tempDir("vtc-fake-pm-");
  const npm = join(bin, "npm");
  writeFile(bin, "npm", FAKE_NPM);
  chmodSync(npm, 0o755);
  const install = {
    id: "install",
    layer: "L0" as const,
    phase: "install" as const,
    command: [npm, "ci"],
  };
  const h = harness(
    { "vendor/lint.mjs": LINT, "src/a.ts": "export const a = 1;\n", ...files },
    config([install, ...gates]),
    { allow: [[NODE], [npm], ["node_modules/.bin/lint-tool"]] },
  );
  return { h, npm };
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

  it("says when an install gate has no scripts-free form, and hashes after it", async () => {
    const plain = {
      id: "deps",
      layer: "L0" as const,
      phase: "install" as const,
      command: [NODE, "tools/install.mjs"],
    };
    const h = harness({ "src/a.ts": "export const a = 1;\n" }, config([plain, explicitLint]));
    writeFile(h.repo, "src/a.ts", "export const a = 2;\n");
    const report = await h.run({ head: commitAll(h.repo), layers: ["L1"] });
    expect(h.argvs.filter((a) => a.includes("tools/install.mjs"))).toHaveLength(1);
    expect(result(report, "deps").status).toBe("pass");
    const evidenceRoot = join(h.repo, ".vtc/evidence/T-1/gates");
    const attempt = readdirSync(evidenceRoot)[0] ?? "";
    expect(readFileSync(join(evidenceRoot, attempt, "tool-integrity.log"), "utf8")).toMatch(
      /deps have no scripts-free form/,
    );
  });
});

describe("H-14: a pinned tool runs from VTC's store", () => {
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
