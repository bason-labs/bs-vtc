/**
 * L2 test metrics and the monotonic rule (§7.2 L2, §7.3): executed test ids, assertions per test
 * and coverage may not get worse than the request's `compare_to`. The Gate Runner keeps no
 * history; engine core passes the previous metrics (AD-13 rule 9). Pure.
 */
import type { MonotonicViolation, TestInventory, TestRecord } from "@vtc/shared";

export interface TestCounts {
  readonly executed: number;
  readonly skipped: number;
  readonly failed: number;
}

/** The inventory of a run: every test with its status and assertion count, sorted by id. */
export const inventoryOf = (tests: readonly TestRecord[]): TestInventory => ({
  v: 1,
  tests: [...tests]
    .map((t) => ({ id: t.id, status: t.status, assertions: t.assertions }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .filter((t, i, all) => i === 0 || all[i - 1]?.id !== t.id),
});

/** Executed = ran (pass, fail or error); failed = fail or error. */
export const countsOf = (tests: readonly Pick<TestRecord, "status">[]): TestCounts => ({
  executed: tests.filter((t) => t.status !== "skipped").length,
  skipped: tests.filter((t) => t.status === "skipped").length,
  failed: tests.filter((t) => t.status === "fail" || t.status === "error").length,
});

export interface MetricsSnapshot {
  readonly inventory: TestInventory;
  readonly line_coverage_pct: number | null;
  readonly diff_coverage_pct: number | null;
}

const EPSILON = 1e-9;

/**
 * How `current` got worse than `previous`. `selected` limits the comparison to the tests this run
 * was asked to run (`GateRunRequest.tests`); `null` means every test was selected, and only then
 * is the skipped count compared as a whole.
 */
export const monotonicViolations = (
  current: MetricsSnapshot,
  previous: MetricsSnapshot,
  selected: ReadonlySet<string> | null = null,
): MonotonicViolation[] => {
  const out: MonotonicViolation[] = [];
  const now = new Map(current.inventory.tests.map((t) => [t.id, t]));
  let perTestSkips = 0;
  for (const before of previous.inventory.tests) {
    if (before.status === "skipped") continue;
    if (selected !== null && !selected.has(before.id)) continue;
    const after = now.get(before.id);
    if (after === undefined) {
      out.push({ kind: "test_missing", test: before.id });
      continue;
    }
    if (after.status === "skipped") {
      out.push({ kind: "test_skipped", test: before.id });
      perTestSkips += 1;
      continue;
    }
    if (
      before.assertions !== null &&
      after.assertions !== null &&
      after.assertions < before.assertions
    ) {
      out.push({ kind: "assertions_dropped", test: before.id });
    }
  }
  if (selected === null && perTestSkips === 0) {
    const skippedNow = countsOf(current.inventory.tests).skipped;
    const skippedBefore = countsOf(previous.inventory.tests).skipped;
    if (skippedNow > skippedBefore) out.push({ kind: "test_skipped" });
  }
  const dropped = (a: number | null, b: number | null): boolean =>
    a !== null && b !== null && a < b - EPSILON;
  if (
    dropped(current.line_coverage_pct, previous.line_coverage_pct) ||
    dropped(current.diff_coverage_pct, previous.diff_coverage_pct)
  ) {
    out.push({ kind: "coverage_dropped" });
  }
  return out;
};
