/**
 * Contracts 4.9.0 (the wave-3 Final Review fix round; spine §5 readings 149–155): G2's design
 * exits (§9.1 step 5).
 */
import { describe, expect, it } from "vitest";
import {
  ApproveInputSchema,
  CONTRACTS_VERSION,
  EVENT_PAYLOAD_SCHEMAS,
  LeadActionSchema,
} from "../src/index.js";

const frozen = [{ path: ".vtc/architecture/spine.md", sha256: "a".repeat(64) }];

describe("contracts 4.9.0", () => {
  it("is MINOR over 4.8.0", () => {
    expect(CONTRACTS_VERSION).toBe("4.9.0");
  });
});

describe("G2 design exits (§9.1 step 5, reading 151)", () => {
  const approve = (over: Record<string, unknown>) =>
    ApproveInputSchema.safeParse({ gates: ["G2"], decision: "approve", frozen, ...over });

  it("re_roll goes with a rejection, category_standard with an approval that picks no direction", () => {
    expect(approve({ decision: "reject", design_exit: "re_roll" }).success).toBe(true);
    expect(approve({ design_exit: "category_standard" }).success).toBe(true);
    expect(approve({ design_exit: "re_roll" }).success).toBe(false);
    expect(approve({ decision: "reject", design_exit: "category_standard" }).success).toBe(false);
    expect(approve({ design_exit: "category_standard", design_direction: "signal" }).success).toBe(
      false,
    );
    expect(
      ApproveInputSchema.safeParse({
        gates: ["G1"],
        decision: "reject",
        frozen,
        design_exit: "re_roll",
      }).success,
    ).toBe(false);
  });

  it("approve_gate and gate.requested offer them; the decisions record the one taken", () => {
    expect(
      LeadActionSchema.parse({
        type: "approve_gate",
        gates: ["G2"],
        artifacts: frozen,
        design_exits: ["re_roll", "category_standard"],
      }),
    ).toMatchObject({ design_exits: ["re_roll", "category_standard"] });
    expect(
      EVENT_PAYLOAD_SCHEMAS["gate.requested"].safeParse({
        gates: ["G2"],
        artifacts: frozen,
        design_exits: ["re_roll", "category_standard"],
      }).success,
    ).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["gate.rejected"].safeParse({ gates: ["G2"], design_exit: "re_roll" })
        .success,
    ).toBe(true);
    expect(
      EVENT_PAYLOAD_SCHEMAS["gate.rejected"].safeParse({
        gates: ["G2"],
        design_exit: "category_standard",
      }).success,
    ).toBe(false);
    expect(
      EVENT_PAYLOAD_SCHEMAS["gate.approved"].safeParse({
        gates: ["G2"],
        frozen,
        design_exit: "category_standard",
      }).success,
    ).toBe(true);
  });
});
