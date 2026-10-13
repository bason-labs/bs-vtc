/**
 * The Gate Runner end to end on real git checkouts (§6.3 step 5, §7.1–§7.3, §15, AD-13, AD-18):
 * allowlist, baseline, flaky tests, the base-fail rule, monotonic metrics, hidden tests, L5,
 * redaction of evidence and the evidence layout.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  engineRepoKey,
  gateExpectationMet,
  GateReportSchema,
  TestInventorySchema,
  TraceabilityReportSchema,
  type GateReport,
  type GateResult,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { finalReviewStepsCovered, HIDDEN_DETAILS_WITHHELD } from "../../src/gates/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import {
  cases,
  commitAll,
  config,
  harness,
  installGate,
  leaksGate,
  lintGate,
  NODE,
  testsGate,
} from "./fixture.js";

afterEach(cleanupDirs);

const gate = (report: GateReport, id: string): GateResult => {
  const found = report.results.find((r) => r.gate_id === id);
  if (found === undefined) throw new Error(`no result for ${id}`);
  return found;
};

const read = (repo: string, rel: string): string => readFileSync(join(repo, rel), "utf8");

describe("a passing run", () => {
  it("runs install first, then the layers, and writes redacted evidence under .vtc/evidence/T-n", async () => {
    const h = harness(
      {
        "tests/unit.json": cases([{ name: "[REQ-1] works", assertions: 2 }, { name: "untagged" }]),
      },
      config([testsGate, installGate, leaksGate]),
    );
    writeFile(h.repo, "src/a.ts", "export const a = 1;\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, req_tags: ["REQ-1", "REQ-2"], files_scope: ["src/**"] });
    GateReportSchema.parse(report);
    expect(report.results.map((r) => [r.gate_id, r.status])).toEqual([
      ["install", "pass"],
      ["tests", "pass"],
      ["secrets", "pass"],
      ["write-scope", "pass"],
    ]);
    expect(report.verdict).toBe("pass");
    const tests = gate(report, "tests");
    expect(tests.tests).toMatchObject({ executed: 2, skipped: 0, failed: 0 });
    expect(tests.report?.path).toMatch(/^\.vtc\/evidence\/T-1\/gates\/[^/]+\/tests\.xml$/);
    const inventory = TestInventorySchema.parse(
      JSON.parse(read(h.repo, tests.tests?.inventory ?? "")),
    );
    expect(inventory.tests.map((t) => [t.id, t.assertions])).toEqual([
      ["tests/unit.json > [REQ-1] works", 2],
      ["tests/unit.json > untagged", null],
    ]);
    expect(report.traceability).toBe(".vtc/evidence/T-1/traceability.json");
    const trace = TraceabilityReportSchema.parse(
      JSON.parse(read(h.repo, report.traceability ?? "")),
    );
    expect(trace.gaps).toEqual(["REQ-2"]);
    expect(existsSync(join(h.repo, ".vtc/state/gates/r1"))).toBe(true);
  });
});

describe("the gate allowlist (§15, AD-13 rule 10)", () => {
  it("never starts a command a human did not confirm, and parks it as infra", async () => {
    const h = harness(
      {},
      config([{ id: "build", layer: "L0", command: [NODE, "tools/build.mjs"] }]),
      {
        allow: [["pnpm"]],
      },
    );
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L0"] });
    expect(gate(report, "build")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(report.verdict).toBe("infra_error");
    const log = gate(report, "build").evidence[0]?.ref ?? "";
    expect(read(h.repo, log)).toMatch(/not in this machine's gate allowlist/);
    const state = join(h.repo, ".vtc/state/gates/r1");
    const logs = existsSync(state) ? readdirSync(state, { recursive: true }).map(String) : [];
    expect(logs.filter((f) => f.endsWith("build.stdout.log"))).toEqual([]);
  });

  it("refuses scanner arguments that would reach the network or run repo code", async () => {
    const h = harness(
      {},
      config([{ id: "osv", layer: "L4", command: ["osv-scanner", "scan", "-r", "."] }]),
    );
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L4"] });
    expect(gate(report, "osv")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(read(h.repo, gate(report, "osv").evidence[0]?.ref ?? "")).toMatch(/--offline/);
  });

  it("parks a run without a confirmed calibration", async () => {
    const yml = config([testsGate]).replace("confirmed: true", "confirmed: false");
    const h = harness({}, yml);
    const report = await h.run({ head: h.base });
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      gate_id: "config",
      status: "error",
      failure_class: "infra",
    });
  });
});

describe("only new problems block (§7.1)", () => {
  it("subtracts tests that already fail on the base commit", async () => {
    const h = harness(
      { "tests/unit.json": cases([{ name: "old", status: "fail" }, { name: "ok" }]) },
      config([installGate, testsGate]),
    );
    writeFile(
      h.repo,
      "tests/unit.json",
      cases([
        { name: "old", status: "fail" },
        { name: "ok", status: "fail" },
      ]),
    );
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L2"] });
    expect(gate(report, "tests")).toMatchObject({
      status: "fail",
      new_violations: 1,
      baseline_violations: 1,
      failure_class: "product",
    });
    expect(gate(report, "tests").evidence[0]).toEqual({
      type: "junit",
      ref: `${gate(report, "tests").report?.path ?? ""}#tests/unit.json > ok`,
    });

    writeFile(h.repo, "tests/unit.json", cases([{ name: "old", status: "fail" }, { name: "ok" }]));
    const same = commitAll(h.repo);
    const clean = await h.run({ head: same, layers: ["L2"] });
    expect(gate(clean, "tests")).toMatchObject({ status: "pass", baseline_violations: 1 });
  });

  it("subtracts findings already present on the base commit", async () => {
    const h = harness({ "src/old.ts": "SECRET=oldvalue123456\n" }, config([leaksGate]));
    writeFile(h.repo, "src/new.ts", "SECRET=newvalue654321\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L4"] });
    const leaks = gate(report, "secrets");
    expect(leaks).toMatchObject({
      status: "fail",
      new_violations: 1,
      baseline_violations: 1,
      failure_class: "product",
    });
    expect(leaks.findings).toHaveLength(1);
    expect(leaks.findings[0]).toMatchObject({
      tool: "gitleaks",
      category: "secret",
      location: { path: "src/new.ts", line: 1 },
    });
    expect(JSON.stringify(report)).not.toContain("newvalue654321");
  });

  it("classifies a failure of a test calibration recorded as flaky", async () => {
    const yml = config([testsGate]).replace(
      "flaky_tests: []",
      'flaky_tests:\n    - "tests/unit.json > wobbly"',
    );
    const h = harness({ "tests/unit.json": cases([{ name: "wobbly" }]) }, yml);
    writeFile(h.repo, "tests/unit.json", cases([{ name: "wobbly", status: "fail" }]));
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L2"] });
    expect(gate(report, "tests")).toMatchObject({ status: "fail", failure_class: "flaky" });
  });
});

describe("the base-fail rule (§6.3 step 2, §7.3)", () => {
  it("expects QA's named tests to fail on the base", async () => {
    const h = harness(
      { "tests/unit.json": cases([{ name: "ok" }]) },
      config([installGate, testsGate, leaksGate]),
    );
    writeFile(h.repo, "tests/acceptance/a.json", cases([{ name: "[REQ-1] new", status: "fail" }]));
    const head = commitAll(h.repo);
    const named = ["tests/acceptance/a.json > [REQ-1] new"];
    const report = await h.run({ head, reason: "base_fail_check", expect: "fail", tests: named });
    expect(report.results.map((r) => r.gate_id)).toEqual(["install", "tests"]);
    expect(gate(report, "tests")).toMatchObject({
      status: "fail",
      failure_class: "product",
      tests: { executed: 1 },
    });
    expect(gateExpectationMet(report)).toBe(true);
    expect(report.traceability).toBeUndefined();

    writeFile(h.repo, "tests/acceptance/a.json", cases([{ name: "[REQ-1] new" }]));
    const passing = commitAll(h.repo);
    const already = await h.run({
      head: passing,
      reason: "base_fail_check",
      expect: "fail",
      tests: named,
    });
    expect(gateExpectationMet(already)).toBe(false);
  });
});

describe("monotonic metrics (§7.3)", () => {
  it("fails L2 when a test that ran before is gone or has fewer assertions", async () => {
    const h = harness(
      { "tests/unit.json": cases([{ name: "a", assertions: 3 }, { name: "b" }]) },
      config([testsGate]),
    );
    const first = await h.run({ head: h.base, layers: ["L2"] });
    const previous = gate(first, "tests").tests;
    expect(previous).toBeDefined();
    writeFile(h.repo, "tests/unit.json", cases([{ name: "a", assertions: 1 }]));
    const head = commitAll(h.repo);
    const report = await h.run({
      head,
      layers: ["L2"],
      ...(previous === undefined ? {} : { compare_to: previous }),
    });
    expect(gate(report, "tests")).toMatchObject({
      status: "fail",
      failure_class: "product",
      monotonic: [
        { kind: "assertions_dropped", test: "tests/unit.json > a" },
        { kind: "test_missing", test: "tests/unit.json > b" },
      ],
    });
  });
});

describe("hidden acceptance tests (§7.3)", () => {
  it("copies them in only for include_hidden runs and withholds their details from evidence", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, config([testsGate]));
    const hiddenDir = join(h.home, "hidden", engineRepoKey(h.repo), "T-1", "tests/hidden");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(
      join(hiddenDir, "h.json"),
      cases([
        {
          name: "[REQ-1] hidden edge",
          status: "fail",
          message: "expected 42 from secretFormula()",
        },
      ]),
    );
    const without = await h.run({ head: h.base, layers: ["L2"] });
    expect(gate(without, "tests")).toMatchObject({ status: "pass", tests: { executed: 1 } });

    writeFile(h.repo, "src/x.ts", "export const x = 1;\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L2"], include_hidden: true, req_tags: ["REQ-1"] });
    const tests = gate(report, "tests");
    expect(tests).toMatchObject({ status: "fail", tests: { executed: 2, failed: 1 } });
    const evidence = read(h.repo, tests.report?.path ?? "");
    expect(evidence).toContain(HIDDEN_DETAILS_WITHHELD);
    expect(evidence).not.toContain("secretFormula");
    const evidenceDir = join(h.repo, ".vtc/evidence/T-1");
    const all = readdirSync(evidenceDir, { recursive: true }).map(String);
    for (const file of all.filter((f) => f.endsWith(".log")))
      expect(read(h.repo, `.vtc/evidence/T-1/${file}`)).not.toContain("secretFormula");
    const trace = TraceabilityReportSchema.parse(
      JSON.parse(read(h.repo, report.traceability ?? "")),
    );
    expect(trace.rows[0]?.tests[0]).toMatchObject({ hidden: true, status: "fail" });
  });
});

describe("symlinks a diff planted (§7.3)", () => {
  it("refuses to copy hidden tests through a symlinked directory, and reports infra", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, config([testsGate]));
    const outside = tempDir("vtc-outside-");
    symlinkSync(outside, join(h.repo, "tests/hidden"));
    const head = commitAll(h.repo);
    const hiddenDir = join(h.home, "hidden", engineRepoKey(h.repo), "T-1", "tests/hidden");
    mkdirSync(hiddenDir, { recursive: true });
    writeFileSync(join(hiddenDir, "h.json"), cases([{ name: "secret edge" }]));
    const report = await h.run({ head, layers: ["L2"], include_hidden: true });
    expect(report.verdict).toBe("infra_error");
    expect(gate(report, "gate-runner")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(readdirSync(outside)).toEqual([]);
  });

  it("never reads a report through a symlink that leaves the checkout", async () => {
    const outside = tempDir("vtc-outside-");
    writeFileSync(join(outside, "junit.xml"), "<testsuites/>");
    const h = harness(
      {},
      config([
        {
          id: "t",
          layer: "L2",
          command: [NODE, "tools/install.mjs"],
          report: { format: "junit", path: "out/junit.xml" },
        },
      ]),
    );
    symlinkSync(outside, join(h.repo, "out"));
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L2"] });
    expect(gate(report, "t")).toMatchObject({ status: "error", failure_class: "infra" });
  });
});

describe("redaction (AD-18)", () => {
  it("redacts a secret a scanner found from every other gate's evidence; raw output keeps it", async () => {
    const h = harness(
      { "tests/unit.json": cases([{ name: "ok" }]), ".env": "API_TOKEN=dotenv-value-9876\n" },
      config([testsGate, leaksGate]),
    );
    writeFile(h.repo, "config/prod.ts", "SECRET=hunter2hunter2hunter2\n");
    writeFile(
      h.repo,
      "tests/unit.json",
      cases([
        {
          name: "leaky",
          status: "fail",
          message: "got hunter2hunter2hunter2 and dotenv-value-9876",
        },
      ]),
    );
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L2", "L4"] });
    const junit = read(h.repo, gate(report, "tests").report?.path ?? "");
    expect(junit).toContain("[REDACTED:known_value]");
    expect(junit).not.toContain("hunter2hunter2hunter2");
    expect(junit).not.toContain("dotenv-value-9876");
    expect(read(h.repo, gate(report, "secrets").report?.path ?? "")).not.toContain(
      "hunter2hunter2hunter2",
    );
    const raw = readdirSync(join(h.repo, ".vtc/state/gates/r1"), { recursive: true })
      .map(String)
      .find((f) => f.endsWith("secrets.report.json"));
    expect(read(h.repo, `.vtc/state/gates/r1/${raw ?? ""}`)).toContain("hunter2hunter2hunter2");
  });
});

describe("L1 and L5", () => {
  it("lints changed files with the base commit's config (§7.2 L1)", async () => {
    const h = harness({ "src/a.ts": "ok\n" }, config([lintGate]));
    writeFile(h.repo, ".lintrc", "off\n");
    writeFile(h.repo, "src/a.ts", "// TODO later\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L1"] });
    expect(gate(report, "lint")).toMatchObject({ status: "fail", new_violations: 1 });
    expect(gate(report, "lint").findings[0]).toMatchObject({
      rule_id: "no-todo",
      location: { path: "src/a.ts", line: 1 },
    });
  });

  it("skips a lint of changed files when nothing changed", async () => {
    const h = harness({}, config([lintGate]));
    const report = await h.run({ head: h.base, layers: ["L1"] });
    expect(gate(report, "lint")).toMatchObject({
      status: "skipped",
      skipped_reason: "no changed files to check",
    });
  });

  it("runs the write-scope check as L5 on round runs", async () => {
    const h = harness({}, config([installGate]));
    writeFile(h.repo, "src/in.ts", "1\n");
    writeFile(h.repo, "README.md", "changed\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, files_scope: ["src/**"] });
    expect(gate(report, "write-scope")).toMatchObject({
      layer: "L5",
      status: "fail",
      failure_class: "product",
      findings: [
        {
          rule_id: "out_of_scope_write",
          category: "test_integrity",
          location: { path: "README.md" },
        },
      ],
    });
  });
});

describe("failures that are not the code's fault", () => {
  it("times out, kills the command and reports infra", async () => {
    const yml = config([
      { id: "slow", layer: "L0", command: [NODE, "tools/sleep.mjs"], timeout_s: 1 },
    ]);
    const h = harness({}, yml);
    const report = await h.run({ head: h.base, layers: ["L0"] });
    expect(gate(report, "slow")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(report.verdict).toBe("infra_error");
  }, 15_000);

  it("reports a missing tool as environment and a missing report as infra", async () => {
    const h = harness(
      {},
      config([
        { id: "ghost", layer: "L0", command: ["definitely-not-installed-vtc"] },
        {
          id: "noreport",
          layer: "L2",
          command: [NODE, "tools/install.mjs"],
          report: { format: "junit", path: "out.xml" },
        },
      ]),
      { allow: [[NODE], ["definitely-not-installed-vtc"]] },
    );
    const report = await h.run({ head: h.base, layers: ["L0", "L2"] });
    expect(gate(report, "ghost")).toMatchObject({ status: "error", failure_class: "environment" });
    expect(gate(report, "noreport")).toMatchObject({ status: "error", failure_class: "infra" });
  });

  it("skips gates whose when_changed does not match and everything after a failed install", async () => {
    const h = harness(
      {},
      config([
        {
          id: "iac",
          layer: "L4",
          command: [NODE, "tools/install.mjs"],
          when_changed: ["infra/**"],
        },
        {
          id: "install",
          layer: "L0",
          phase: "install",
          command: [NODE, "tools/build.mjs", "broken"],
        },
        { id: "build", layer: "L0", command: [NODE, "tools/build.mjs"] },
      ]),
    );
    const report = await h.run({ head: h.base, layers: ["L0", "L4"] });
    expect(report.results.map((r) => [r.gate_id, r.status])).toEqual([
      ["install", "fail"],
      ["build", "skipped"],
      ["iac", "skipped"],
    ]);
  });
});

describe("Final Review coverage (§6.7a)", () => {
  it("reports which deterministic steps a gate run covers", async () => {
    const h = harness(
      { "tests/unit.json": cases([{ name: "ok" }]) },
      config([
        testsGate,
        { id: "arch", layer: "L6", command: [NODE, "tools/install.mjs"], blocking: false },
      ]),
    );
    const request = {
      reason: "final_review" as const,
      scope: "full" as const,
      include_hidden: true,
    };
    const report = await h.run({ head: h.base, task: undefined, feature: "F-1", ...request });
    expect(report.traceability).toBe(".vtc/evidence/F-1/traceability.json");
    expect(finalReviewStepsCovered({ ...request, layers: undefined }, report)).toEqual([1, 2, 6]);
    expect(finalReviewStepsCovered({ ...request, layers: ["L2"] }, report)).toEqual([2, 6]);
    expect(finalReviewStepsCovered({ ...request, reason: "round" }, report)).toEqual([]);
  });
});
