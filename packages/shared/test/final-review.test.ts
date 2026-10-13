import { describe, expect, it } from "vitest";
import {
  finalReviewStepsCovered,
  GateResultSchema,
  type GateResult,
  type TraceabilityReport,
} from "../src/index.js";
import { validGateResult } from "./fixtures.js";

const l2 = (): GateResult =>
  GateResultSchema.parse({
    ...validGateResult(),
    status: "pass",
    failure_class: undefined,
    monotonic: [],
  });
const l6 = (status: "pass" | "fail" | "skipped" | "error"): GateResult =>
  GateResultSchema.parse({
    gate_id: "arch",
    layer: "L6",
    phase: "verify",
    status,
    blocking: false,
    new_violations: 0,
    baseline_violations: 0,
    duration_ms: 1,
    ...(status === "fail" || status === "error" ? { failure_class: "product" } : {}),
    ...(status === "skipped" ? { skipped_reason: "not configured" } : {}),
  });
const trace = (hidden: boolean): Pick<TraceabilityReport, "rows"> => ({
  rows: [
    {
      req: "REQ-1",
      covered: true,
      tests: [{ id: "[REQ-1] t", status: "pass", hidden, provenance: "spec" }],
    },
  ],
});
const request = {
  reason: "final_review",
  scope: "full",
  layers: undefined,
  include_hidden: true,
} as const;

describe("finalReviewStepsCovered (§6.7a)", () => {
  it("reports full gates, the full acceptance run and architecture conformance", () => {
    expect(finalReviewStepsCovered(request, { results: [l2(), l6("pass")] }, trace(true))).toEqual([
      1, 2, 6,
    ]);
  });
  it("never claims step 2 unless hidden tests actually ran", () => {
    const report = { results: [l2(), l6("fail")] };
    expect(finalReviewStepsCovered(request, report, trace(false))).toEqual([1, 6]);
    expect(finalReviewStepsCovered(request, report)).toEqual([1, 6]);
    expect(
      finalReviewStepsCovered({ ...request, include_hidden: false }, report, trace(true)),
    ).toEqual([1, 6]);
  });
  it("drops step 1 when layers were narrowed or a gate errored", () => {
    expect(
      finalReviewStepsCovered({ ...request, layers: ["L2"] }, { results: [l2()] }, trace(true)),
    ).toEqual([2]);
    expect(finalReviewStepsCovered(request, { results: [l2(), l6("error")] }, trace(true))).toEqual(
      [2],
    );
    expect(finalReviewStepsCovered(request, { results: [l2(), l6("skipped")] })).toEqual([1]);
  });
  it("covers nothing outside a full Final Review run", () => {
    const report = { results: [l2(), l6("pass")] };
    expect(finalReviewStepsCovered({ ...request, reason: "round" }, report, trace(true))).toEqual(
      [],
    );
    expect(finalReviewStepsCovered({ ...request, scope: "affected" }, report, trace(true))).toEqual(
      [],
    );
  });
});
