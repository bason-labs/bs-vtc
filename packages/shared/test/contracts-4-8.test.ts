/**
 * Contracts 4.8.0 (the wave-3 fix round; spine §5 reading 146): the DESIGN check names the
 * requirements no component maps and a UI run's unusable `screens.yaml`, and `approve_gate`
 * carries the report the approval is refused on.
 */
import { describe, expect, it } from "vitest";
import { DesignCoverageReportSchema, LeadActionSchema } from "../src/index.js";

const EMPTY = {
  reqs_without_component: [],
  reqs_without_screen: [],
  screens_without_req: [],
  components_unregistered: [],
};

describe("DesignCoverageReport 4.8.0", () => {
  it("fails on a requirement no component maps, and on an unusable screens.yaml", () => {
    expect(DesignCoverageReportSchema.parse({ ...EMPTY, ok: true }).ok).toBe(true);
    const unmapped = { ...EMPTY, reqs_without_component: ["REQ-2"] };
    expect(DesignCoverageReportSchema.safeParse({ ...unmapped, ok: true }).success).toBe(false);
    expect(DesignCoverageReportSchema.safeParse({ ...unmapped, ok: false }).success).toBe(true);
    const missing = { ...EMPTY, screens_problem: "no screens.yaml" };
    expect(DesignCoverageReportSchema.safeParse({ ...missing, ok: true }).success).toBe(false);
    expect(DesignCoverageReportSchema.safeParse({ ...missing, ok: false }).success).toBe(true);
  });

  it("reads a 4.5.0 report (no new fields) as before", () => {
    const old = { reqs_without_screen: [], screens_without_req: [], components_unregistered: [] };
    expect(DesignCoverageReportSchema.parse({ ...old, ok: true })).toEqual({ ...EMPTY, ok: true });
  });

  it("approve_gate carries the report", () => {
    const gate = LeadActionSchema.parse({
      type: "approve_gate",
      gates: ["G2"],
      artifacts: [{ path: ".vtc/architecture/spine.md", sha256: "a".repeat(64) }],
      design_coverage: { ...EMPTY, reqs_without_component: ["REQ-1"], ok: false },
    });
    expect(gate).toMatchObject({ design_coverage: { ok: false } });
  });
});
