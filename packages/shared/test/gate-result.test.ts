import { describe, expect, it } from "vitest";
import {
  gateReportVerdict,
  GateReportSchema,
  GateResultSchema,
  GateRunRequestSchema,
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
    ["tests.executed", { tests: { executed: 1.5, skipped: 0, failed: 0 } }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(GateResultSchema, { ...validGateResult(), ...patch }, path);
  });
});

describe("GateReportSchema and its verdict", () => {
  it("accepts a report whose verdict matches its results", () => {
    expectValid(GateReportSchema, validGateReport());
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
