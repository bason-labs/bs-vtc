import { describe, expect, it } from "vitest";
import { modelFallbackText, roleCostText, roleRunNotes } from "@/lib/role-run-notes";
import { sampleEvent } from "../golden-samples";

/**
 * What a role run cost and which model it ran on: a run whose model has no known price keeps
 * `cost_usd` null and counts `role.submitted.budget_usd` toward the budget (H-12; spine §5
 * reading 236), and a dispatch the host refused the model for runs on the host default
 * (`role.dispatched.model_fallback`, D-cx; reading 244).
 */
const ROLE = {
  actor: "role" as const,
  role: "engineer" as const,
  prompt_sha: "4".repeat(64),
  host: "codex" as const,
  model: "gpt-6.1-sol",
};

const dispatched = (seq: number, action: string, data: Record<string, unknown> = {}) =>
  sampleEvent(
    seq,
    "role.dispatched",
    {
      action_id: action,
      dispatch: "headless",
      agent: "vtc-engineer",
      pack: `.vtc/state/packs/${action}.md`,
      resume: null,
      ...data,
    },
    { ...ROLE, actor: "engine" },
  );

const submitted = (
  seq: number,
  action: string,
  cost: number | null,
  data: Record<string, unknown> = {},
) =>
  sampleEvent(
    seq,
    "role.submitted",
    {
      action_id: action,
      exit: "built",
      findings: 0,
      questions: 0,
      session_ref: null,
      head: "b".repeat(40),
      ...data,
    },
    { ...ROLE, tokens: { in: 1000, out: 200, cache_r: 0, cache_w: 0 }, cost_usd: cost },
  );

describe("roleCostText (H-12)", () => {
  it("shows a priced run's cost", () => {
    expect(roleCostText(1.2, undefined)).toBe("$1.20");
  });
  it("shows an unpriced run as unknown, and what it counts toward the budget", () => {
    expect(roleCostText(null, 0.84)).toBe("Cost unknown · counted as $0.84 toward the budget");
    expect(roleCostText(null, undefined)).toBe("Cost unknown");
  });
  it("says what the budget counts when it differs from the cost", () => {
    expect(roleCostText(0.5, 0.5)).toBe("$0.50");
    expect(roleCostText(0.5, 0.75)).toBe("$0.50 · counted as $0.75 toward the budget");
  });
  it("shows a cost below a cent without rounding it to nothing", () => {
    expect(roleCostText(0.004, undefined)).toBe("<$0.01");
  });
});

describe("modelFallbackText (D-cx)", () => {
  it("names the refused model and the host default", () => {
    expect(modelFallbackText({ requested: "gpt-6-astra", reason: "model_refused" })).toBe(
      "The host refused gpt-6-astra; ran on the host default",
    );
  });
});

describe("roleRunNotes (role.dispatched / role.submitted by action id)", () => {
  it("joins each run's cost and model fallback", () => {
    const notes = roleRunNotes([
      dispatched(40, "a-20"),
      submitted(41, "a-20", 1.2),
      dispatched(42, "a-21", {
        model_fallback: {
          requested: "gpt-6-astra",
          reason: "model_refused",
          detail: "model is not available on your plan",
        },
      }),
      submitted(43, "a-21", null, { budget_usd: 0.84 }),
      dispatched(44, "a-22"),
    ]);
    expect(notes.get("a-20")).toEqual({ cost: "$1.20", fallback: null, fallbackDetail: null });
    expect(notes.get("a-21")).toEqual({
      cost: "Cost unknown · counted as $0.84 toward the budget",
      fallback: "The host refused gpt-6-astra; ran on the host default",
      fallbackDetail: "model is not available on your plan",
    });
    // In flight: nothing to say yet.
    expect(notes.get("a-22")).toEqual({ cost: null, fallback: null, fallbackDetail: null });
  });
});
