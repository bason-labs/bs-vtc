/**
 * Traceability built by code (§7.4, AD-18 rule 3): REQ/AC tags in JUnit test ids → the tests that
 * cover each requirement. A requirement with no passing test is a gap. Pure; the Gate Runner
 * writes the result, redacted, to `.vtc/evidence/<T-n|F-n>/traceability.json`.
 */
import {
  parseReqTags,
  TraceabilityReportSchema,
  type RequirementRef,
  type TestRecord,
  type TraceabilityReport,
  type TraceTest,
} from "@vtc/shared";

export interface TraceabilityInput {
  readonly run: string;
  readonly task?: string | undefined;
  readonly feature?: string | undefined;
  /**
   * The requirements to trace (the task's `covers`, or every REQ for a feature). Empty = every
   * requirement tagged in the run's tests.
   */
  readonly reqTags: readonly RequirementRef[];
  readonly tests: readonly (Pick<TestRecord, "id" | "status"> & { readonly hidden?: boolean })[];
  /**
   * Changed files no requirement covers (§7.4 scope creep). The caller computes it; without
   * per-test coverage contexts it is empty.
   */
  readonly scopeCreep?: readonly string[];
  readonly builtAt: string;
}

const refSort = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** True when a test tagged `tag` covers `ref` (an AC also covers its requirement). */
export const tagCovers = (tag: RequirementRef, ref: RequirementRef): boolean =>
  tag === ref || (!ref.includes(".AC-") && tag.startsWith(`${ref}.AC-`));

export const buildTraceability = (input: TraceabilityInput): TraceabilityReport => {
  const tagged = input.tests.map((t) => ({ test: t, tags: parseReqTags(t.id) }));
  const refs =
    input.reqTags.length > 0
      ? [...new Set(input.reqTags)]
      : [...new Set(tagged.flatMap((t) => t.tags))].sort(refSort);
  const rows = refs.map((req) => {
    const tests: TraceTest[] = tagged
      .filter((t) => t.tags.some((tag) => tagCovers(tag, req)))
      .map(({ test }) => ({
        id: test.id,
        status: test.status,
        hidden: test.hidden ?? false,
        provenance: "unknown" as const,
      }));
    return { req, tests, covered: tests.some((t) => t.status === "pass") };
  });
  return TraceabilityReportSchema.parse({
    run: input.run,
    ...(input.task === undefined ? {} : { task: input.task }),
    ...(input.feature === undefined || input.task !== undefined ? {} : { feature: input.feature }),
    rows,
    gaps: rows.filter((r) => !r.covered).map((r) => r.req),
    scope_creep: [...new Set(input.scopeCreep ?? [])].sort(),
    built_at: input.builtAt,
  });
};
