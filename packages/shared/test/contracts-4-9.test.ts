/**
 * Contracts 4.9.0 (the wave-3 Final Review fix round; spine §5 readings 149–155): G2's design
 * exits (§9.1 step 5) and the user's price table (§11, H-1).
 */
import { describe, expect, it } from "vitest";
import {
  ApproveInputSchema,
  CONTRACTS_VERSION,
  EVENT_PAYLOAD_SCHEMAS,
  LeadActionSchema,
  ModelPriceSchema,
  priceTokens,
  ProjectConfigSchema,
  UserConfigSchema,
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

describe("the price table (§11, H-1; reading 152)", () => {
  const price = ModelPriceSchema.parse({
    input_per_mtok: 1.25,
    cached_input_per_mtok: 0.125,
    output_per_mtok: 10,
  });

  it("prices each of the four token types once, per million tokens", () => {
    expect(price.cache_write_per_mtok).toBe(0);
    expect(priceTokens({ in: 1_000_000, out: 0, cache_r: 0, cache_w: 0 }, price)).toBe(1.25);
    expect(priceTokens({ in: 200_000, out: 10_000, cache_r: 100_000, cache_w: 0 }, price)).toBe(
      0.3625,
    );
    expect(
      priceTokens(
        { in: 0, out: 0, cache_r: 0, cache_w: 1_000_000 },
        { ...price, cache_write_per_mtok: 1.5 },
      ),
    ).toBe(1.5);
    expect(priceTokens({ in: 0, out: 0, cache_r: 0, cache_w: 0 }, price)).toBe(0);
  });

  it("lives in the user config only, never in project.yaml", () => {
    const user = UserConfigSchema.parse({ version: 1, prices: { "gpt-test": price } });
    expect(user.prices?.["gpt-test"]?.output_per_mtok).toBe(10);
    expect(UserConfigSchema.parse({ version: 1 }).prices).toBeUndefined();
    expect(
      UserConfigSchema.safeParse({ version: 1, prices: { "gpt-test": { input_per_mtok: -1 } } })
        .success,
    ).toBe(false);
    expect(UserConfigSchema.safeParse({ version: 1, prices: { "../x": price } }).success).toBe(
      false,
    );
    expect(
      ProjectConfigSchema.safeParse({ version: 1, prices: { "gpt-test": price } }).success,
    ).toBe(false);
  });
});
