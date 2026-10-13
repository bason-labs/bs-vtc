/**
 * The Gate Runner end to end on real git checkouts (§6.3 step 5, §7.1–§7.3, §15, AD-13, AD-18):
 * allowlist, baseline, flaky tests, the base-fail rule, monotonic metrics, hidden tests, L5,
 * redaction of evidence and the evidence layout.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  engineRepoKey,
  finalReviewStepsCovered,
  gateExpectationMet,
  GateReportSchema,
  TestInventorySchema,
  TraceabilityReportSchema,
  type GateReport,
  type GateResult,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  HIDDEN_DETAILS_WITHHELD,
  ScannerUnavailableError,
  type ScannerStore,
} from "../../src/gates/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import {
  cases,
  commitAll,
  config,
  harness,
  installGate,
  JUNIT,
  leaksGate,
  lintGate,
  NODE,
  osvGate,
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
    // Nothing is removed through the symlink either.
    expect(readdirSync(outside)).toEqual(["junit.xml"]);
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
  const finalGates = config([
    testsGate,
    { id: "arch", layer: "L6", command: [NODE, "tools/install.mjs"], blocking: false },
  ]);
  const request = {
    reason: "final_review" as const,
    scope: "full" as const,
    include_hidden: true,
  };
  const plantHidden = (home: string, repo: string, task: string, name: string): void => {
    const dir = join(home, "hidden", engineRepoKey(repo), task, "tests/hidden");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${task}.json`), cases([{ name }]));
  };
  const traceOf = (repo: string, report: GateReport) =>
    TraceabilityReportSchema.parse(JSON.parse(read(repo, report.traceability ?? "")));

  it("never claims the full acceptance run (step 2) when no hidden test was copied in", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, finalGates);
    plantHidden(h.home, h.repo, "T-1", "[REQ-1] hidden one");
    plantHidden(h.home, h.repo, "T-2", "[REQ-2] hidden two");
    const report = await h.run({
      head: h.base,
      task: undefined,
      feature: "F-1",
      req_tags: ["REQ-1", "REQ-2"],
      ...request,
    });
    expect(report.traceability).toBe(".vtc/evidence/F-1/traceability.json");
    // The request names no tasks: nothing hidden ran, and evidence says so.
    expect(gate(report, "tests").tests).toMatchObject({ executed: 1 });
    const trace = traceOf(h.repo, report);
    expect(finalReviewStepsCovered({ ...request, layers: undefined }, report, trace)).toEqual([
      1, 6,
    ]);
    const notes = readdirSync(join(h.repo, ".vtc/evidence/F-1/gates"), { recursive: true }).map(
      String,
    );
    const note = notes.find((f) => f.endsWith("hidden-tests.log")) ?? "";
    expect(read(h.repo, `.vtc/evidence/F-1/gates/${note}`)).toMatch(/not copied/);
  });

  it("reports the steps a run covers, step 2 only when hidden tests ran", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, finalGates);
    plantHidden(h.home, h.repo, "T-1", "[REQ-1] hidden one");
    const report = await h.run({ head: h.base, req_tags: ["REQ-1"], ...request });
    expect(gate(report, "tests").tests).toMatchObject({ executed: 2 });
    const trace = traceOf(h.repo, report);
    expect(finalReviewStepsCovered({ ...request, layers: undefined }, report, trace)).toEqual([
      1, 2, 6,
    ]);
    expect(finalReviewStepsCovered({ ...request, layers: undefined }, report)).toEqual([1, 6]);
    expect(finalReviewStepsCovered({ ...request, layers: ["L2"] }, report, trace)).toEqual([2, 6]);
    expect(finalReviewStepsCovered({ ...request, reason: "round" }, report, trace)).toEqual([]);
  });

  it("copies the hidden tests of every task hidden_tasks names into a feature run (step 2)", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, finalGates);
    plantHidden(h.home, h.repo, "T-1", "[REQ-1] hidden one");
    plantHidden(h.home, h.repo, "T-2", "[REQ-2] hidden two");
    plantHidden(h.home, h.repo, "T-3", "[REQ-3] not in this feature");
    const report = await h.run({
      head: h.base,
      task: undefined,
      feature: "F-1",
      req_tags: ["REQ-1", "REQ-2"],
      hidden_tasks: ["T-1", "T-2"],
      ...request,
    });
    expect(gate(report, "tests").tests).toMatchObject({ executed: 3 });
    const trace = traceOf(h.repo, report);
    expect(trace.rows.flatMap((r) => r.tests.filter((t) => t.hidden)).length).toBe(2);
    expect(finalReviewStepsCovered({ ...request, layers: undefined }, report, trace)).toEqual([
      1, 2, 6,
    ]);
    const notes = readdirSync(join(h.repo, ".vtc/evidence/F-1/gates"), { recursive: true }).map(
      String,
    );
    expect(notes.some((f) => f.endsWith("hidden-tests.log"))).toBe(false);
  });

  it("refuses to let one task's hidden test overwrite another's", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, finalGates);
    for (const task of ["T-1", "T-2"]) {
      const dir = join(h.home, "hidden", engineRepoKey(h.repo), task, "tests/hidden");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "same.json"), cases([{ name: `[REQ-1] ${task}` }]));
    }
    const report = await h.run({
      head: h.base,
      task: undefined,
      feature: "F-1",
      hidden_tasks: ["T-1", "T-2"],
      ...request,
    });
    expect(report.verdict).toBe("infra_error");
    expect(gate(report, "gate-runner")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(read(h.repo, gate(report, "gate-runner").evidence[0]?.ref ?? "")).toMatch(
      /T-1 and T-2 both have tests\/hidden\/same\.json/,
    );
    // Nothing hidden stays in the checkout or the repo.
    expect(existsSync(join(h.repo, "tests/hidden"))).toBe(false);
  });
});

describe("the gates.yml the run started with (gates_config_hash, spine §5 readings 20 and 46b)", () => {
  const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

  it("runs when the base commit's gates.yml has the request's hash", async () => {
    const yml = config([testsGate]);
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, yml);
    const report = await h.run({ head: h.base, layers: ["L2"], gates_config_hash: sha(yml) });
    expect(report.verdict).toBe("pass");
    expect(gate(report, "tests").status).toBe("pass");
  });

  it("runs nothing and reports infra when the base's gates.yml differs from the run's", async () => {
    const yml = config([testsGate]);
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, yml);
    const report = await h.run({
      head: h.base,
      layers: ["L2"],
      gates_config_hash: sha(`${yml}# edited\n`),
    });
    expect(report.results.map((r) => [r.gate_id, r.status, r.failure_class])).toEqual([
      ["config", "error", "infra"],
    ]);
    expect(report.verdict).toBe("infra_error");
    expect(read(h.repo, gate(report, "config").evidence[0]?.ref ?? "")).toMatch(
      /does not match the gates\.yml this run started with/,
    );
  });

  it("reports infra when the base commit has no gates.yml", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, config([testsGate]));
    rmSync(join(h.repo, ".vtc/gates.yml"));
    const head = commitAll(h.repo, "drop gates");
    const report = await h.run({ head, layers: ["L2"] });
    // The base still has it: the run uses the base commit's file, never the head's.
    expect(gate(report, "tests").status).toBe("pass");
    const later = await h.run({ head, base: head, layers: ["L2"], gates_config_hash: sha("x") });
    expect(later.results.map((r) => [r.gate_id, r.status, r.failure_class])).toEqual([
      ["config", "error", "infra"],
    ]);
    expect(read(h.repo, gate(later, "config").evidence[0]?.ref ?? "")).toMatch(/not committed/);
  });
});

describe("Checkov where it has no pinned build (D-u, spine §5 reading 41)", () => {
  const iacGate = {
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
  const unpinnedCheckov = (): ScannerStore => ({
    names: ["gitleaks", "osv-scanner", "opengrep", "checkov"],
    ensure: (name) =>
      Promise.reject(
        name === "checkov"
          ? new ScannerUnavailableError(name, "darwin-arm64")
          : new Error(`no fake ${name}`),
      ),
  });
  const FAKE_CHECKOV = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.argv[process.argv.indexOf("--output-file-path") + 1];
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "results_sarif.sarif"), JSON.stringify({ version: "2.1.0", runs: [{ tool: { driver: { name: "checkov" } }, results: [] }] }));
`;

  it("skips the IaC gate with a visible reason when Checkov is not installed", async () => {
    const empty = tempDir("vtc-path-");
    const h = harness({ "infra/main.tf": "resource {}\n" }, config([iacGate]), {
      scanners: unpinnedCheckov,
      env: { ...process.env, PATH: empty },
    });
    const report = await h.run({ head: h.base, layers: ["L4"] });
    expect(gate(report, "iac")).toMatchObject({ status: "skipped" });
    expect(gate(report, "iac").skipped_reason).toMatch(
      /checkov has no pinned build for darwin-arm64 and is not installed/,
    );
    expect(report.verdict).toBe("pass");
  });

  it("runs a user-installed Checkov found on PATH outside the repo", async () => {
    const bin = tempDir("vtc-path-");
    writeFileSync(join(bin, "checkov"), FAKE_CHECKOV, { mode: 0o755 });
    const h = harness({ "infra/main.tf": "resource {}\n" }, config([iacGate]), {
      scanners: unpinnedCheckov,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
    });
    const report = await h.run({ head: h.base, layers: ["L4"] });
    expect(gate(report, "iac")).toMatchObject({ status: "pass" });
  });

  it("never takes a Checkov from inside the repo or from a relative PATH entry", async () => {
    const env: Record<string, string | undefined> = { ...process.env, PATH: "bin" };
    const h = harness(
      { "infra/main.tf": "resource {}\n", "bin/checkov": FAKE_CHECKOV },
      config([iacGate]),
      { scanners: unpinnedCheckov, env },
    );
    chmodSync(join(h.repo, "bin/checkov"), 0o755);
    // The runner reads the environment when a gate starts: both a relative entry (resolved in
    // the checkout) and the repo's own directory are planted by the diff, not installed.
    env.PATH = `bin:${join(h.repo, "bin")}`;
    const inside = await h.run({ head: h.base, layers: ["L4"] });
    expect(gate(inside, "iac")).toMatchObject({ status: "skipped" });
  });

  it("keeps refusing a pinned scanner that fails for any other reason", async () => {
    const h = harness({ "infra/main.tf": "resource {}\n" }, config([iacGate]), {
      scanners: () => ({
        names: ["checkov"],
        ensure: () => Promise.reject(new Error("checksum mismatch")),
      }),
    });
    const report = await h.run({ head: h.base, layers: ["L4"] });
    expect(gate(report, "iac")).toMatchObject({ status: "error", failure_class: "infra" });
  });
});

describe("monotonic metrics on redacted inventories (§7.3, AD-18)", () => {
  it("matches a test whose id holds a .env value across rounds", async () => {
    const h = harness(
      {
        ".env": "DB_HOST=localhost-database\n",
        "tests/unit.json": cases([
          { name: "connects to localhost-database", assertions: 2 },
          { name: "connects to b" },
        ]),
      },
      config([testsGate]),
    );
    const first = await h.run({ head: h.base, layers: ["L2"] });
    const previous = gate(first, "tests").tests;
    if (previous === undefined) throw new Error("no metrics");
    expect(read(h.repo, previous.inventory)).not.toContain("localhost-database");
    // Redaction reorders the ids; the written inventory is sorted again.
    expect(
      TestInventorySchema.parse(JSON.parse(read(h.repo, previous.inventory))).tests.map(
        (t) => t.id,
      ),
    ).toEqual([
      "tests/unit.json > connects to [REDACTED:known_value]",
      "tests/unit.json > connects to b",
    ]);
    writeFile(h.repo, "src/x.ts", "export const x = 1;\n");
    const head = commitAll(h.repo);
    const second = await h.run({ head, layers: ["L2"], compare_to: previous });
    expect(gate(second, "tests")).toMatchObject({ status: "pass", monotonic: [] });
    expect(second.verdict).toBe("pass");
    // Selected by its raw id, compared in the redacted space.
    const selected = await h.run({
      head,
      layers: ["L2"],
      compare_to: previous,
      tests: ["tests/unit.json > connects to localhost-database"],
    });
    expect(gate(selected, "tests")).toMatchObject({ status: "pass", monotonic: [] });
  });

  it("reports infra, never a silent pass, when the previous inventory cannot be read", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "a" }]) }, config([testsGate]));
    const first = await h.run({ head: h.base, layers: ["L2"] });
    const previous = gate(first, "tests").tests;
    if (previous === undefined) throw new Error("no metrics");
    const missing = await h.run({
      head: h.base,
      layers: ["L2"],
      compare_to: { ...previous, inventory: ".vtc/evidence/T-1/gone.inventory.json" },
    });
    expect(gate(missing, "monotonic")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(missing.verdict).toBe("infra_error");
    writeFile(h.repo, ".vtc/evidence/T-1/bad.inventory.json", '{"v":1,"tests":[{"id":"x"}]}\n');
    const invalid = await h.run({
      head: h.base,
      layers: ["L2"],
      compare_to: { ...previous, inventory: ".vtc/evidence/T-1/bad.inventory.json" },
    });
    expect(invalid.verdict).toBe("infra_error");
  });

  it("keeps a flaky classification when tests also went missing", async () => {
    const yml = config([testsGate]).replace(
      "flaky_tests: []",
      'flaky_tests:\n    - "tests/unit.json > wobbly"',
    );
    const h = harness({ "tests/unit.json": cases([{ name: "wobbly" }, { name: "gone" }]) }, yml);
    const first = await h.run({ head: h.base, layers: ["L2"] });
    const previous = gate(first, "tests").tests;
    if (previous === undefined) throw new Error("no metrics");
    writeFile(h.repo, "tests/unit.json", cases([{ name: "wobbly", status: "fail" }]));
    const head = commitAll(h.repo);
    const report = await h.run({ head, layers: ["L2"], compare_to: previous });
    expect(gate(report, "tests")).toMatchObject({
      status: "fail",
      failure_class: "flaky",
      monotonic: [{ kind: "test_missing", test: "tests/unit.json > gone" }],
    });
  });
});

describe("the base-fail rule across L2 gates (§6.3 step 2)", () => {
  it("decides once over every L2 gate when QA's tests span two of them", async () => {
    const e2eGate = {
      id: "e2e",
      layer: "L2" as const,
      cwd: "e2e",
      command: [NODE, "../tools/fake-test.mjs", JUNIT],
      report: { format: "junit" as const, path: JUNIT },
    };
    const h = harness(
      {
        "tests/unit.json": cases([{ name: "ok" }]),
        "e2e/tests/flow.json": cases([{ name: "ok" }]),
      },
      config([testsGate, e2eGate]),
    );
    writeFile(h.repo, "tests/acceptance/a.json", cases([{ name: "[REQ-1] unit", status: "fail" }]));
    writeFile(h.repo, "e2e/tests/new.json", cases([{ name: "[REQ-1] flow", status: "fail" }]));
    const head = commitAll(h.repo);
    const named = ["tests/acceptance/a.json > [REQ-1] unit", "tests/new.json > [REQ-1] flow"];
    const report = await h.run({ head, reason: "base_fail_check", expect: "fail", tests: named });
    expect(report.results.map((r) => [r.gate_id, r.status])).toEqual([
      ["tests", "fail"],
      ["e2e", "fail"],
    ]);
    expect(gateExpectationMet(report)).toBe(true);

    writeFile(h.repo, "e2e/tests/new.json", cases([{ name: "[REQ-1] flow" }]));
    const half = commitAll(h.repo);
    const passing = await h.run({
      head: half,
      reason: "base_fail_check",
      expect: "fail",
      tests: named,
    });
    expect(gateExpectationMet(passing)).toBe(false);
    expect(gate(passing, "e2e").evidence[0]?.ref).toMatch(/#tests\/new\.json > \[REQ-1\] flow$/);
  });
});

describe("baseline findings that move (§7.1)", () => {
  it("keeps a lint violation the diff only shifted, and counts a second identical one as new", async () => {
    const h = harness({ "src/a.ts": "// TODO old\n" }, config([lintGate]));
    writeFile(h.repo, "src/a.ts", "export const x = 1;\n// TODO old\n");
    const shifted = commitAll(h.repo);
    const report = await h.run({ head: shifted, layers: ["L1"] });
    expect(gate(report, "lint")).toMatchObject({
      status: "pass",
      new_violations: 0,
      baseline_violations: 1,
    });
    // Evidence of the first run is not part of the next diff (it would be linted too).
    rmSync(join(h.repo, ".vtc/evidence"), { recursive: true, force: true });
    writeFile(h.repo, "src/a.ts", "export const x = 1;\n// TODO old\n// TODO old\n");
    const doubled = commitAll(h.repo);
    const again = await h.run({ head: doubled, layers: ["L1"] });
    expect(gate(again, "lint")).toMatchObject({
      status: "fail",
      new_violations: 1,
      baseline_violations: 1,
    });
  });
});

describe("the gates come from the base commit (§7.1)", () => {
  it("ignores uncommitted edits to gates.yml and parks when the base has none", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, config([testsGate]));
    writeFile(h.repo, ".vtc/gates.yml", config([{ id: "other", layer: "L2", command: [NODE] }]));
    const report = await h.run({ head: h.base, layers: ["L2"] });
    expect(report.results.map((r) => r.gate_id)).toEqual(["tests"]);

    rmSync(join(h.repo, ".vtc/gates.yml"));
    const head = commitAll(h.repo);
    const gone = await h.run({ head, base: head, layers: ["L2"] });
    expect(gone.results[0]).toMatchObject({ gate_id: "config", failure_class: "infra" });
    expect(read(h.repo, gone.results[0]?.evidence[0]?.ref ?? "")).toMatch(/not committed/);
  });
});

describe("scanner configs a diff adds (§7.2 L4/L5)", () => {
  it("scans with the base version of scanner configs and flags the new one in L5", async () => {
    const h = harness({ "src/old.ts": "export const a = 1;\n" }, config([leaksGate]));
    writeFile(h.repo, "src/new.ts", "SECRET=newvalue654321\n");
    writeFile(h.repo, ".gitleaksignore", "src/new.ts\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, files_scope: ["src/**", ".gitleaksignore"] });
    expect(gate(report, "secrets")).toMatchObject({ status: "fail", new_violations: 1 });
    // Named exactly in files_scope: a plan allowed this config change, so L5 accepts it.
    expect(gate(report, "write-scope")).toMatchObject({ status: "pass" });
    const scoped = await h.run({ head, files_scope: ["src/**", "*"] });
    expect(gate(scoped, "write-scope").findings).toEqual([
      expect.objectContaining({
        rule_id: "new_suppression",
        location: { path: ".gitleaksignore" },
      }),
    ]);
  });
});

describe("scanner configs in another letter case (case-insensitive file systems)", () => {
  it("scans without a .GitleaksIgnore the diff added, and flags it in L5", async () => {
    // On macOS, the scanner's existsSync(".gitleaksignore") would find .GitleaksIgnore.
    const h = harness({ "src/old.ts": "export const a = 1;\n" }, config([leaksGate]));
    writeFile(h.repo, "src/new.ts", "SECRET=newvalue654321\n");
    writeFile(h.repo, ".GitleaksIgnore", "src/new.ts\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, files_scope: ["src/**", "*"] });
    expect(gate(report, "secrets")).toMatchObject({ status: "fail", new_violations: 1 });
    expect(gate(report, "write-scope").findings).toEqual([
      expect.objectContaining({
        rule_id: "new_suppression",
        location: { path: ".GitleaksIgnore" },
      }),
    ]);
  });
});

describe("a malformed request (the Gate Runner is the trust boundary for test material)", () => {
  it("validates the request first and never joins a bad task id into a hidden-tests path", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, config([testsGate]));
    // ~/.vtc/hidden/<repo-key>/../T-9 is outside the task directories.
    const escaped = join(h.home, "hidden", "T-9", "tests/hidden");
    mkdirSync(escaped, { recursive: true });
    writeFileSync(join(escaped, "h.json"), cases([{ name: "[REQ-9] not this repo's" }]));
    const report = await h.runUnparsed({
      head: h.base,
      layers: ["L2"],
      include_hidden: true,
      hidden_tasks: ["../T-9"],
    });
    GateReportSchema.parse(report);
    expect(report.verdict).toBe("infra_error");
    expect(report.results.map((r) => r.gate_id)).toEqual(["gate-runner"]);
    expect(gate(report, "gate-runner")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(existsSync(join(h.repo, "tests/hidden/h.json"))).toBe(false);
    const log = gate(report, "gate-runner").evidence[0]?.ref ?? "";
    expect(read(h.repo, log)).toMatch(/request rejected.*hidden_tasks/s);
  });

  it("rejects hidden_tasks without include_hidden", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, config([testsGate]));
    const report = await h.runUnparsed({ head: h.base, hidden_tasks: ["T-2"] });
    expect(report.verdict).toBe("infra_error");
    expect(report.results.map((r) => r.gate_id)).toEqual(["gate-runner"]);
  });
});

describe("tool sections of pyproject.toml and package.json (§7.2 L1/L5)", () => {
  /** A fake ruff: flags "TODO" in changed files unless pyproject.toml ignores ALL. */
  const FAKE_RUFF = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [out, ...files] = process.argv.slice(2);
const off = readFileSync("pyproject.toml", "utf8").includes('ignore = ["ALL"]');
const results = files.filter((f) => f.endsWith(".py")).map((f) => ({
  filePath: f,
  messages: off ? [] : readFileSync(f, "utf8").split("\\n").flatMap((l, i) =>
    l.includes("TODO") ? [{ ruleId: "FIX002", severity: 2, message: "TODO left", line: i + 1 }] : []),
}));
mkdirSync(".vtc/state/gates", { recursive: true });
writeFileSync(out, JSON.stringify(results));
process.exit(results.some((r) => r.messages.length > 0) ? 1 : 0);
`;
  const ruffGate = {
    id: "ruff",
    layer: "L1" as const,
    command: [NODE, "tools/fake-ruff.mjs", ".vtc/state/gates/ruff.json", "{changed}"],
    report: { format: "json" as const, path: ".vtc/state/gates/ruff.json" },
  };
  const PYPROJECT =
    '[project]\nname = "app"\ndependencies = []\n\n[tool.ruff.lint]\nselect = ["FIX"]\n';

  it("lints with the base [tool.ruff] when the diff adds an ignore, and flags it in L5", async () => {
    const h = harness(
      { "tools/fake-ruff.mjs": FAKE_RUFF, "pyproject.toml": PYPROJECT, "src/a.py": "x = 1\n" },
      config([ruffGate]),
    );
    const weakened = PYPROJECT.replace("dependencies = []", 'dependencies = ["requests"]').replace(
      'select = ["FIX"]',
      'select = ["FIX"]\nignore = ["ALL"]',
    );
    writeFile(h.repo, "pyproject.toml", weakened);
    writeFile(h.repo, "src/a.py", "x = 1  # TODO later\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, files_scope: ["src/**", "*.toml"] });
    expect(gate(report, "ruff")).toMatchObject({ status: "fail", new_violations: 1 });
    expect(gate(report, "write-scope").findings).toEqual([
      expect.objectContaining({
        rule_id: "protected_modified",
        location: { path: "pyproject.toml" },
      }),
    ]);
    // The checkout is the head commit again afterwards.
    expect(read(h.repo, "pyproject.toml")).toBe(weakened);
  });

  it("accepts a dependency change that leaves the tool sections alone", async () => {
    const h = harness(
      { "tools/fake-ruff.mjs": FAKE_RUFF, "pyproject.toml": PYPROJECT, "src/a.py": "x = 1\n" },
      config([ruffGate]),
    );
    writeFile(h.repo, "pyproject.toml", PYPROJECT.replace("[]", '["requests"]'));
    writeFile(h.repo, "src/a.py", "x = 2\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, files_scope: ["src/**", "*.toml"] });
    expect(gate(report, "ruff")).toMatchObject({ status: "pass" });
    expect(gate(report, "write-scope")).toMatchObject({ status: "pass" });
  });
});

describe("package-manager configs a diff adds (§7.2 L1/L5)", () => {
  /**
   * A fake lint run through a package manager: like `npm run lint` under a planted
   * `script-shell=true`, it reports nothing when the checkout's .npmrc says so.
   */
  const FAKE_NPM_LINT = `
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [out, ...files] = process.argv.slice(2);
const off = existsSync(".npmrc") && readFileSync(".npmrc", "utf8").includes("script-shell=true");
const results = files.filter((f) => f.endsWith(".ts")).map((f) => ({
  filePath: f,
  messages: off ? [] : readFileSync(f, "utf8").split("\\n").flatMap((l, i) =>
    l.includes("TODO") ? [{ ruleId: "no-todo", severity: 2, message: "TODO left", line: i + 1 }] : []),
}));
mkdirSync(".vtc/state/gates", { recursive: true });
writeFileSync(out, JSON.stringify(results));
process.exit(results.some((r) => r.messages.length > 0) ? 1 : 0);
`;
  const npmLintGate = {
    id: "lint",
    layer: "L1" as const,
    command: [NODE, "tools/npm-lint.mjs", ".vtc/state/gates/lint.json", "{changed}"],
    report: { format: "json" as const, path: ".vtc/state/gates/lint.json" },
  };

  it("lints without a .npmrc the diff added, and flags it in L5", async () => {
    // The project's own protected_configs (.lintrc only) predate the package-manager globs.
    const h = harness(
      { "tools/npm-lint.mjs": FAKE_NPM_LINT, "src/a.ts": "ok\n" },
      config([npmLintGate]),
    );
    writeFile(h.repo, ".npmrc", "script-shell=true\n");
    writeFile(h.repo, "src/a.ts", "// TODO later\n");
    const head = commitAll(h.repo);
    const report = await h.run({ head, files_scope: ["**"] });
    expect(gate(report, "lint")).toMatchObject({ status: "fail", new_violations: 1 });
    expect(gate(report, "write-scope").findings).toEqual([
      expect.objectContaining({ rule_id: "protected_modified", location: { path: ".npmrc" } }),
    ]);
    // The checkout is the head commit again afterwards.
    expect(read(h.repo, ".npmrc")).toBe("script-shell=true\n");
  });
});

describe("the osv-scanner offline database (§7.2, §15)", () => {
  it("does not start the dependency gate without the database", async () => {
    const h = harness({}, config([osvGate]));
    const report = await h.run({ head: h.base, layers: ["L4"] });
    expect(gate(report, "dependencies")).toMatchObject({ status: "error", failure_class: "infra" });
    expect(read(h.repo, gate(report, "dependencies").evidence[0]?.ref ?? "")).toMatch(
      /offline vulnerability database/,
    );
  });
});

describe("a report that cannot be written (GateRunner.run never throws)", () => {
  it("returns a minimal infra report when evidence cannot be written", async () => {
    const h = harness({ "tests/unit.json": cases([{ name: "ok" }]) }, config([testsGate]));
    const outside = tempDir("vtc-outside-");
    mkdirSync(join(h.repo, ".vtc"), { recursive: true });
    symlinkSync(outside, join(h.repo, ".vtc/evidence"));
    const report = await h.run({ head: h.base, layers: ["L2"] });
    GateReportSchema.parse(report);
    expect(report.verdict).toBe("infra_error");
    expect(report.results.map((r) => r.gate_id)).toEqual(["gate-runner"]);
    expect(readdirSync(outside)).toEqual([]);
  });
});

describe("not built yet (gates/README.md, follow-up increments)", () => {
  // §7.2 sandbox, two phases: install reaches package registries only; test/scan has no network.
  // Today every gate runs with the user's network and file access (exec.ts runCommand).
  it.todo("runs verify-phase gates without network access (§7.2 two-phase sandbox)");
  it.todo("lets install-phase gates reach package registries only (§7.2 two-phase sandbox)");
});
