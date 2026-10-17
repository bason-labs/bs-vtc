import { describe, expect, it } from "vitest";
import { headlessRuns } from "@/lib/headless";
import { runNotices } from "@/lib/notices";
import { modelFallbackText, roleCostText, roleRunNotes } from "@/lib/role-run-notes";
import { sampleEvent, samplesOfType } from "../golden-samples";

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

/** A headless start and end of `action` (`cause` on the end), from the golden samples' shapes. */
const headless = (seq: number, action: string, cause: string | null) => {
  const [started] = samplesOfType("headless.started");
  const [ended] = samplesOfType("headless.ended");
  if (started === undefined || ended === undefined) throw new Error("no headless samples");
  const start = sampleEvent(
    seq,
    "headless.started",
    { ...started.data, action_id: action },
    {
      role: "engineer",
      host: "codex",
    },
  );
  const end = sampleEvent(
    seq + 1,
    "headless.ended",
    {
      ...ended.data,
      action_id: action,
      ...(cause === null ? {} : { outcome: "error", cause, exit_code: 1, duration_ms: 2_000 }),
    },
    { role: "engineer", host: "codex" },
  );
  return [start, end];
};

const FALLBACK = {
  model_fallback: {
    requested: "gpt-6-astra",
    reason: "model_refused",
    detail: "model is not available on your plan",
  },
};

describe("a second refusal (D-cx, reading 244: the default refused too is an ordinary error)", () => {
  const events = [
    dispatched(50, "a-30"),
    ...headless(51, "a-30", "model_refused"),
    dispatched(53, "a-31", FALLBACK),
    ...headless(54, "a-31", "model_refused"),
  ];
  it("shows the fallback dispatch's refusal as an error, not as a dispatch again", () => {
    const runs = new Map(headlessRuns(events).map((r) => [r.actionId, r]));
    expect(runs.get("a-30")?.status).toEqual({
      label: "Model refused: dispatched again on the host default",
      tone: "warn",
    });
    expect(runs.get("a-31")?.status).toEqual({
      label: "Error: the host refused its default model too",
      tone: "danger",
    });
  });
  it("raises the second refusal as an error notice, the first as a warning", () => {
    const notices = runNotices(events);
    const of = (action: string) => notices.find((n) => n.title.includes(` ${action} ended`));
    expect(of("a-30")).toMatchObject({
      tone: "warn",
      title: expect.stringContaining("Model refused: dispatched again") as unknown,
    });
    expect(of("a-31")).toMatchObject({
      tone: "danger",
      title: expect.stringContaining("Error: the host refused its default model too") as unknown,
    });
  });
  it("never says the fallback ran on the host default when the default was refused", () => {
    expect(roleRunNotes(events).get("a-31")?.fallback).toBe(
      "The host refused gpt-6-astra; the host default was refused too",
    );
  });
});

describe("the cost of a failed or rejected run (H-12, contracts 5.8.0 reading 249)", () => {
  it("shows a closing event's cost and what it counts toward the budget", () => {
    const notes = roleRunNotes([
      dispatched(60, "a-40"),
      sampleEvent(
        61,
        "role.failed",
        { action_id: "a-40", kind: "error", message: "x", retryable: false, budget_usd: 0.31 },
        { ...ROLE, actor: "engine" },
      ),
      dispatched(62, "a-41"),
      sampleEvent(
        63,
        "role.rejected",
        { action_id: "a-41", reason: "write_scope", issues: [] },
        { ...ROLE, actor: "engine", tokens: null, cost_usd: 0.5 },
      ),
    ]);
    expect(notes.get("a-40")?.cost).toBe("Cost unknown · counted as $0.31 toward the budget");
    expect(notes.get("a-41")?.cost).toBe("$0.50");
  });
});
