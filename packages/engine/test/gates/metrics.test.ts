/** Monotonic metrics (§7.3) and traceability built by code (§7.4). */
import { MonotonicViolationSchema, TestInventorySchema, type TestRecord } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  buildTraceability,
  countsOf,
  inventoryOf,
  monotonicViolations,
  tagCovers,
} from "../../src/gates/index.js";

const t = (
  id: string,
  status: TestRecord["status"],
  assertions: number | null = null,
): TestRecord => ({
  id,
  status,
  assertions,
});

const snap = (tests: TestRecord[], line: number | null = null, diff: number | null = null) => ({
  inventory: inventoryOf(tests),
  line_coverage_pct: line,
  diff_coverage_pct: diff,
});

describe("inventory and counts", () => {
  it("sorts, dedupes and validates; counts executed, skipped and failed", () => {
    const inv = inventoryOf([t("b", "pass"), t("a", "fail"), t("a", "fail"), t("c", "skipped")]);
    expect(TestInventorySchema.parse(inv).tests.map((x) => x.id)).toEqual(["a", "b", "c"]);
    expect(countsOf(inv.tests)).toEqual({ executed: 2, skipped: 1, failed: 1 });
  });
});

describe("monotonicViolations (§7.3)", () => {
  const before = snap(
    [t("a", "pass", 3), t("b", "pass", 2), t("c", "fail"), t("s", "skipped")],
    80,
    90,
  );

  it("reports nothing when nothing got worse", () => {
    const after = snap(
      [t("a", "pass", 4), t("b", "fail", 2), t("c", "pass"), t("d", "pass")],
      80,
      95,
    );
    expect(monotonicViolations(after, before)).toEqual([]);
  });

  it("reports missing and newly skipped tests, dropped assertions and coverage", () => {
    const after = snap([t("a", "pass", 1), t("b", "skipped"), t("s", "skipped")], 79.5, 90);
    const found = monotonicViolations(after, before);
    for (const v of found) MonotonicViolationSchema.parse(v);
    expect(found).toEqual([
      { kind: "assertions_dropped", test: "a" },
      { kind: "test_skipped", test: "b" },
      { kind: "test_missing", test: "c" },
      { kind: "coverage_dropped" },
    ]);
  });

  it("reports a grown skipped count, but only for a full selection", () => {
    const after = snap([
      t("a", "pass", 3),
      t("b", "pass", 2),
      t("c", "fail"),
      t("s", "skipped"),
      t("n", "skipped"),
    ]);
    expect(monotonicViolations(after, snap(before.inventory.tests))).toEqual([
      { kind: "test_skipped" },
    ]);
    expect(monotonicViolations(snap([t("a", "pass", 3)]), before, new Set(["a"]))).toEqual([]);
  });
});

describe("buildTraceability (§7.4)", () => {
  const tests = [
    { id: "api > [REQ-1.AC-1] sends", status: "pass" as const },
    { id: "api > [REQ-1.AC-2] [REQ-2] rejects", status: "fail" as const, hidden: true },
    { id: "untagged", status: "pass" as const },
  ];
  it("traces the requested requirements, an AC covering its REQ, and lists gaps", () => {
    const report = buildTraceability({
      run: "r1",
      task: "T-1",
      reqTags: ["REQ-1", "REQ-1.AC-2", "REQ-3"],
      tests,
      builtAt: "2026-10-13T08:00:00.000Z",
    });
    expect(report.rows.map((r) => [r.req, r.tests.map((x) => x.id), r.covered])).toEqual([
      ["REQ-1", ["api > [REQ-1.AC-1] sends", "api > [REQ-1.AC-2] [REQ-2] rejects"], true],
      ["REQ-1.AC-2", ["api > [REQ-1.AC-2] [REQ-2] rejects"], false],
      ["REQ-3", [], false],
    ]);
    expect(report.rows[1]?.tests[0]?.hidden).toBe(true);
    expect(report.gaps).toEqual(["REQ-1.AC-2", "REQ-3"]);
  });
  it("traces every tagged requirement for a feature without a list", () => {
    const report = buildTraceability({
      run: "r1",
      feature: "F-1",
      reqTags: [],
      tests,
      builtAt: "2026-10-13T08:00:00.000Z",
    });
    expect(report.rows.map((r) => r.req)).toEqual(["REQ-1.AC-1", "REQ-1.AC-2", "REQ-2"]);
    expect(report.feature).toBe("F-1");
  });
  it("matches tags exactly", () => {
    expect(tagCovers("REQ-12", "REQ-1")).toBe(false);
    expect(tagCovers("REQ-1.AC-3", "REQ-1")).toBe(true);
    expect(tagCovers("REQ-1", "REQ-1.AC-3")).toBe(false);
  });
});
