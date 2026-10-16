import { describe, expect, it } from "vitest";
import { GateReportSchema, TaskDetailSchema, type GateReportInput } from "@vtc/shared";
import {
  AFTER_SCRIPTS_WARNING,
  gateReportModel,
  LAYER_LABELS,
  selfRebuiltWarning,
} from "@/lib/gates";
import { readFixture } from "../fixtures";

const sha = (c: string) => c.repeat(40);

const report = (over: Partial<GateReportInput> = {}) =>
  GateReportSchema.parse({
    run: "golden-1",
    task: "T-2",
    reason: "round",
    scope: "affected",
    base: sha("a"),
    head: sha("b"),
    results: [
      {
        gate_id: "lint",
        layer: "L1",
        phase: "verify",
        status: "fail",
        blocking: true,
        new_violations: 2,
        baseline_violations: 5,
        failure_class: "product",
        report: { format: "sarif", path: ".vtc/evidence/T-2/round-2/lint.sarif" },
        findings: [
          {
            tool: "eslint",
            rule_id: "no-unused-vars",
            category: "maintainability",
            title: "Unused variable x",
            location: { path: "src/t-2/reset.ts", line: 4 },
            evidence: { type: "sarif", ref: ".vtc/evidence/T-2/round-2/lint.sarif#0" },
          },
        ],
        duration_ms: 1500,
      },
      {
        gate_id: "typecheck",
        layer: "L0",
        phase: "verify",
        status: "pass",
        blocking: true,
        new_violations: 0,
        baseline_violations: 0,
        duration_ms: 3900,
      },
      {
        gate_id: "tests",
        layer: "L2",
        phase: "verify",
        status: "fail",
        blocking: true,
        new_violations: 0,
        baseline_violations: 0,
        failure_class: "product",
        tests: {
          executed: 40,
          skipped: 2,
          failed: 1,
          inventory: ".vtc/evidence/T-2/round-2/tests.json",
          line_coverage_pct: 80,
          diff_coverage_pct: null,
        },
        monotonic: [{ kind: "test_missing", test: "reset [REQ-2] refuses expired" }],
        duration_ms: 12_100,
      },
      {
        gate_id: "arch",
        layer: "L6",
        phase: "verify",
        status: "skipped",
        blocking: false,
        new_violations: 0,
        baseline_violations: 0,
        skipped_reason: "when_changed did not match",
        duration_ms: 0,
      },
    ],
    verdict: "fail",
    started_at: "2026-10-13T09:30:00.000Z",
    finished_at: "2026-10-13T09:31:30.000Z",
    traceability: ".vtc/evidence/T-2/traceability.json",
    ...over,
  });

describe("gateReportModel (§17 drill-down: gate reports per layer)", () => {
  it("groups results by layer in L0–L6 order with the layer's name", () => {
    const model = gateReportModel(report());
    expect(model.layers.map((l) => l.layer)).toEqual(["L0", "L1", "L2", "L6"]);
    expect(model.layers[1]?.label).toBe(LAYER_LABELS.L1);
    expect(model.verdict).toEqual({ label: "Failed", tone: "danger" });
    expect(model.title).toBe("Round · affected");
    expect(model.range).toBe("aaaaaaa..bbbbbbb");
    expect(model.duration).toBe("1 min 30 s");
    expect(model.traceability).toBe(".vtc/evidence/T-2/traceability.json");
  });

  it("gives a layer the worst status of its gates", () => {
    const layers = gateReportModel(report()).layers;
    expect(layers.map((l) => l.status.label)).toEqual(["Passed", "Failed", "Failed", "Skipped"]);
  });

  it("explains each result: violations, failure class, tests, coverage, monotonic, skip", () => {
    const model = gateReportModel(report());
    const lint = model.layers[1]?.results[0];
    expect(lint?.details).toEqual([
      "2 new violations · 5 in the baseline",
      "Failure class: product",
      "1.5 s",
    ]);
    expect(lint?.report).toEqual({ path: ".vtc/evidence/T-2/round-2/lint.sarif", format: "sarif" });
    expect(lint?.findings.map((f) => f.title)).toEqual(["Unused variable x"]);
    const tests = model.layers[2]?.results[0];
    expect(tests?.details).toEqual([
      "Failure class: product",
      "40 executed · 2 skipped · 1 failed",
      "Line coverage 80% · diff coverage not measured",
      "Got worse: test missing (reset [REQ-2] refuses expired)",
      "12.1 s",
    ]);
    const arch = model.layers[3]?.results[0];
    expect(arch?.blocking).toBe(false);
    expect(arch?.details).toEqual(["Skipped: when_changed did not match"]);
  });

  it("warns on a gate whose tools were hashed only after an install's scripts ran (H-14, reading 251)", () => {
    const r = report();
    const typecheck = r.results[1];
    if (typecheck === undefined) throw new Error("fixture");
    typecheck.tool = {
      source: "project",
      sha256: "ab".repeat(32),
      workspace_sha256: "cd".repeat(32),
      tampered: [],
      baseline: "after_scripts",
    };
    const layers = gateReportModel(r).layers;
    expect(layers[0]?.results[0]?.warnings).toEqual([AFTER_SCRIPTS_WARNING]);
    // it passed: the warning does not change its status
    expect(layers[0]?.results[0]?.status.label).toBe("Passed");
    expect(layers[1]?.results[0]?.warnings).toEqual([]);
  });

  it("warns on a gate run after packages rebuilt themselves during install (H-14, reading 252)", () => {
    const r = report();
    const typecheck = r.results[1];
    if (typecheck === undefined) throw new Error("fixture");
    typecheck.tool = {
      source: "project",
      sha256: "ab".repeat(32),
      workspace_sha256: "cd".repeat(32),
      tampered: [],
      baseline: "after_scripts",
      self_rebuilt: [
        {
          package: "node_modules/esbuild",
          files: ["node_modules/esbuild/bin/esbuild"],
          file_count: 1,
        },
      ],
    };
    const warnings = gateReportModel(r).layers[0]?.results[0]?.warnings;
    expect(warnings).toEqual([AFTER_SCRIPTS_WARNING, selfRebuiltWarning(["node_modules/esbuild"])]);
    expect(warnings?.[1]).toMatch(/node_modules\/esbuild\.$/);
  });

  it("only links reports the artifacts route can serve", () => {
    const r = report();
    const first = r.results[0];
    if (first?.report === undefined) throw new Error("fixture");
    first.report.path = ".vtc/state/raw/lint.sarif";
    expect(gateReportModel(r).layers[1]?.results[0]?.report).toBeNull();
  });

  it("names a base-fail check whose tests failed as the expected outcome", () => {
    const model = gateReportModel(report({ reason: "base_fail_check", expect: "fail" }));
    expect(model.title).toBe("Base fail check · affected · expected to fail");
    expect(model.verdict).toEqual({ label: "Failed as expected", tone: "ok" });
  });

  it("reads the golden run's T-1 report", () => {
    const detail = TaskDetailSchema.parse(readFixture("task-T-1"));
    const [first] = detail.gate_reports;
    if (first === undefined) throw new Error("fixture has a gate report");
    const model = gateReportModel(first);
    expect(model.verdict.label).toBe("Passed");
    expect(model.layers.map((l) => l.layer)).toEqual(["L0", "L2"]);
    expect(model.layers[1]?.results[0]?.details).toContain(
      "Line coverage 84.2% · diff coverage 96.5%",
    );
    expect(model.layers[1]?.results[0]?.report?.path).toBe(".vtc/evidence/T-1/round-1/junit.xml");
  });
});
