import { LOOKBACK_LIMITS } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { costRegressed, evaluateTrigger } from "../../src/upstream/index.js";

const SHA = "a".repeat(64);
const at = "2026-10-15T12:00:00.000Z";

describe("costRegressed (reading 230(5): the canary rule for every source)", () => {
  it("raises a rate drift from a zero baseline once the current rate is above 0", () => {
    expect(costRegressed("escalations_per_100", 0, 40)).toBe(true);
    expect(costRegressed("cap_hits_per_100", 0, 5)).toBe(true);
    // zero both times is quiet
    expect(costRegressed("escalations_per_100", 0, 0)).toBe(false);
    expect(costRegressed("cap_hits_per_100", 0, 0)).toBe(false);
  });
  it("keeps the ratio rule for a baseline above zero", () => {
    const ratio = LOOKBACK_LIMITS.rollbackRateRatio;
    expect(costRegressed("escalations_per_100", 10, 10 * ratio)).toBe(true);
    expect(costRegressed("escalations_per_100", 10, 10 * ratio - 0.1)).toBe(false);
  });
});

describe("evaluateTrigger cost_regression", () => {
  it("opens a cost issue for a time-window drift from 0 to N escalations per 100", () => {
    const item = evaluateTrigger(
      {
        type: "cost_regression",
        role: "engineer",
        host: "claude-code",
        metric: "escalations_per_100",
        baselinePromptSha: `${SHA}@time_window`,
        promptSha: SHA,
        baseline: 0,
        current: 40,
        at,
      },
      { vtcVersion: "0.5.0" },
    );
    expect(item).not.toBeNull();
    expect(item).toMatchObject({ target: "upstream", kind: "cost" });
    if (item?.target !== "upstream") throw new Error("expected an upstream item");
    // the infinite percentage stays out of the metrics, so the facts stay JSON numbers
    expect(item.facts.metrics).toEqual({
      "baseline.escalations_per_100": 0,
      "current.escalations_per_100": 40,
    });
  });
});
