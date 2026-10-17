import { describe, expect, it } from "vitest";
import {
  gateReportVerdict,
  GateReportSchema,
  GateResultSchema,
  GateRunRequestSchema,
  normalizeSeverity,
  TestInventorySchema,
  ToolFindingSchema,
  WriteScopeReportSchema,
} from "../src/index.js";
import { COMMIT, SHA, validGateReport, validGateResult } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("GateResultSchema", () => {
  it("accepts a classified L2 failure with test counts", () => {
    expectValid(GateResultSchema, validGateResult());
  });
  it("accepts a skipped gate with its reason", () => {
    expectValid(GateResultSchema, {
      gate_id: "checkov",
      layer: "L4",
      phase: "verify",
      status: "skipped",
      blocking: true,
      new_violations: 0,
      baseline_violations: 0,
      duration_ms: 0,
      skipped_reason: "when_changed did not match infra/**",
    });
  });
  it.each([
    ["failure_class", { failure_class: undefined }],
    ["failure_class", { status: "pass", failure_class: "product" }],
    ["failure_class", { failure_class: "cosmic_rays" }],
    ["tests", { layer: "L1" }],
    ["skipped_reason", { skipped_reason: "why not" }],
    ["skipped_reason", { status: "skipped", failure_class: undefined }],
    ["blocking", { blocking: false }],
    ["report.path", { report: { format: "junit", path: "/tmp/junit.xml" } }],
    ["new_violations", { new_violations: -1 }],
    ["tests.executed", { tests: { ...validGateResult().tests, executed: 1.5 } }],
    ["tests.inventory", { tests: { executed: 1, skipped: 0, failed: 0 } }],
    ["tests.line_coverage_pct", { tests: { ...validGateResult().tests, line_coverage_pct: 101 } }],
    [
      "monotonic",
      { status: "pass", failure_class: undefined, monotonic: [{ kind: "test_missing" }] },
    ],
    ["monotonic.0.kind", { monotonic: [{ kind: "vibes_dropped" }] }],
    ["findings", { new_violations: 0, findings: [toolFinding()] }],
    ["findings.0.score", { findings: [{ ...toolFinding(), score: 11 }] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(GateResultSchema, { ...validGateResult(), ...patch }, path);
  });
});

/** An Opengrep SARIF result as the Gate Runner extracts it (AD-13 rule 9). */
function toolFinding() {
  return {
    tool: "opengrep",
    rule_id: "js.express.xss",
    category: "security",
    title: "Reflected XSS",
    location: { path: "src/auth/reset/controller.ts", line: 12 },
    evidence: { type: "sarif", ref: ".vtc/evidence/T-7/round-2/opengrep.sarif#3" },
    snippet: "res.send(req.query.next)",
    cwe: "CWE-79",
    score: 7.5,
    sarif_level: "error",
  } as const;
}

describe("tool findings: the seam from scanners to triage (§6.3 step 8)", () => {
  it("a gate carries its new violations with raw severity signals; triage normalises", () => {
    const sast = {
      gate_id: "opengrep",
      layer: "L4",
      phase: "verify",
      status: "fail",
      blocking: true,
      new_violations: 1,
      baseline_violations: 4,
      report: { format: "sarif", path: ".vtc/evidence/T-7/round-2/opengrep.sarif" },
      findings: [toolFinding()],
      failure_class: "product",
      duration_ms: 900,
    };
    const finding = expectValid(GateResultSchema, sast).findings[0];
    expect(finding?.score).toBe(7.5);
    expect(normalizeSeverity({ source: "tool", score: 7.5, sarifLevel: "error" })).toBe("high");
    expectInvalid(ToolFindingSchema, { ...toolFinding(), severity: "high" }, "");
  });
});

describe("monotonic metrics (§7.3)", () => {
  it("a failed L2 gate lists how the metrics got worse than compare_to", () => {
    const worse = {
      ...validGateResult(),
      monotonic: [
        { kind: "test_missing", test: "[REQ-3.AC-1] reset rejects expired tokens" },
        { kind: "coverage_dropped" },
      ],
    };
    expect(expectValid(GateResultSchema, worse).monotonic).toHaveLength(2);
  });
  it("the test inventory is sorted by id, without duplicates", () => {
    const record = (id: string) => ({ id, status: "pass", assertions: 3 }) as const;
    expectValid(TestInventorySchema, { v: 1, tests: [record("a"), record("b")] });
    expectInvalid(TestInventorySchema, { v: 1, tests: [record("b"), record("a")] }, "tests");
    expectInvalid(TestInventorySchema, { v: 1, tests: [record("a"), record("a")] }, "tests");
  });
});

describe("GateReportSchema and its verdict", () => {
  it("accepts a report whose verdict matches its results", () => {
    expectValid(GateReportSchema, validGateReport());
  });
  it("points at the traceability report the Gate Runner built (AD-18 rule 3)", () => {
    const path = ".vtc/evidence/T-7/traceability.json";
    expect(
      expectValid(GateReportSchema, { ...validGateReport(), traceability: path }).traceability,
    ).toBe(path);
    expectInvalid(
      GateReportSchema,
      { ...validGateReport(), traceability: "/tmp/t.json" },
      "traceability",
    );
  });
  it("rejects a verdict that does not follow from the results", () => {
    expectInvalid(GateReportSchema, { ...validGateReport(), verdict: "pass" }, "verdict");
    expectInvalid(GateReportSchema, { ...validGateReport(), results: [] }, "results");
  });
  it("infra or environment failures on blocking gates win over product failures", () => {
    const product = { status: "fail", blocking: true, failure_class: "product" } as const;
    const infra = { status: "error", blocking: true, failure_class: "infra" } as const;
    const env = { status: "fail", blocking: true, failure_class: "environment" } as const;
    const warn = { status: "fail", blocking: false, failure_class: "product" } as const;
    const pass = { status: "pass", blocking: true } as const;
    expect(gateReportVerdict([pass])).toBe("pass");
    expect(gateReportVerdict([pass, warn])).toBe("pass");
    expect(gateReportVerdict([pass, product])).toBe("fail");
    expect(gateReportVerdict([product, infra])).toBe("infra_error");
    expect(gateReportVerdict([env])).toBe("infra_error");
    expect(gateReportVerdict([{ status: "fail", blocking: true, failure_class: "flaky" }])).toBe(
      "fail",
    );
  });
});

describe("GateRunRequestSchema", () => {
  const request = () => ({
    run: "r1",
    task: "T-7",
    reason: "round",
    scope: "affected",
    base: COMMIT,
    head: COMMIT,
    checkout: ".vtc/state/checkouts/T-7",
    files_scope: ["src/auth/reset/**"],
    protected: [{ path: "test/acceptance/reset.test.ts", sha256: SHA }],
    req_tags: ["REQ-3", "REQ-3.AC-2"],
  });
  it("accepts a per-round request", () => {
    expectValid(GateRunRequestSchema, request());
  });
  it("carries the previous L2 metrics the Gate Runner compares against (§7.3)", () => {
    const previous = validGateResult().tests;
    expect(
      expectValid(GateRunRequestSchema, { ...request(), compare_to: previous }).compare_to,
    ).toMatchObject({ inventory: previous.inventory });
    expectInvalid(
      GateRunRequestSchema,
      { ...request(), compare_to: { executed: 1, skipped: 0, failed: 0 } },
      "compare_to.inventory",
    );
  });
  it("names the feature's tasks whose hidden tests a Final Review run copies in (§6.7a step 2)", () => {
    const finalReview = {
      ...request(),
      task: undefined,
      feature: "F-1",
      reason: "final_review",
      scope: "full",
      include_hidden: true,
    };
    expect(
      expectValid(GateRunRequestSchema, { ...finalReview, hidden_tasks: ["T-1", "T-2"] })
        .hidden_tasks,
    ).toEqual(["T-1", "T-2"]);
    expect(expectValid(GateRunRequestSchema, request()).hidden_tasks).toBeUndefined();
    expectInvalid(
      GateRunRequestSchema,
      { ...finalReview, include_hidden: false, hidden_tasks: ["T-1"] },
      "hidden_tasks",
    );
    expectInvalid(
      GateRunRequestSchema,
      { ...finalReview, hidden_tasks: ["T-1", "T-1"] },
      "hidden_tasks",
    );
    expectInvalid(
      GateRunRequestSchema,
      { ...finalReview, hidden_tasks: ["F-1"] },
      "hidden_tasks.0",
    );
  });
  it("pins the gates.yml the run started with by hash (spine §5 reading 20)", () => {
    expect(
      expectValid(GateRunRequestSchema, { ...request(), gates_config_hash: SHA }).gates_config_hash,
    ).toBe(SHA);
    expectInvalid(
      GateRunRequestSchema,
      { ...request(), gates_config_hash: "abc" },
      "gates_config_hash",
    );
  });
  it.each([
    ["checkout", { checkout: "/Users/me/wt" }],
    ["reason", { reason: "deploy" }],
    ["scope", { scope: "some" }],
    ["base", { base: "HEAD" }],
    ["req_tags.0", { req_tags: ["AC-1"] }],
    ["protected.0.sha256", { protected: [{ path: "a.ts", sha256: "x" }] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(GateRunRequestSchema, { ...request(), ...patch }, path);
  });
});

describe("WriteScopeReportSchema", () => {
  it("ok exactly when there are no violations", () => {
    expectValid(WriteScopeReportSchema, { ok: true });
    expectValid(WriteScopeReportSchema, {
      ok: false,
      violations: [{ kind: "protected_modified", path: "test/acceptance/reset.test.ts" }],
    });
    expectInvalid(WriteScopeReportSchema, { ok: false, violations: [] }, "ok");
    expectInvalid(
      WriteScopeReportSchema,
      { ok: true, violations: [{ kind: "new_skip", path: "a.test.ts" }] },
      "ok",
    );
  });
});
