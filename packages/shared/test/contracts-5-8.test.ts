/**
 * Contracts 5.8.0 (MINOR; spine §5 reading 249): the round-6 integration fixes. A run the engine
 * closes with `role.rejected`, `role.failed` or `limit.hit` carries what it counts toward the
 * budgets (`budget_usd`, H-12), as `role.submitted` does, so a run with no task (an advisor, the
 * front half) is never counted at $0 when its model has no known price. A project check tool hashed
 * only after an install's scripts ran says so (`ToolIntegrity.baseline`, H-14).
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  ReplayTrialRefSchema,
  ToolIntegritySchema,
  validateEventData,
} from "../src/index.js";

describe("contracts 5.8.0", () => {
  it("is MINOR over 5.7.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.8.0");
  });

  describe("budget_usd on the events that close a run (H-12, reading 249)", () => {
    const closing = {
      "role.rejected": { action_id: "a-1", reason: "write_scope", issues: [] },
      "role.failed": { action_id: "a-1", kind: "error", message: "x", retryable: false },
      "limit.hit": {
        host: "codex",
        window: "five_hour",
        model: null,
        resets_at: null,
        session_ref: null,
        pending_action_ids: ["a-1"],
        auto_resume_at: null,
      },
    } as const;
    it.each(Object.entries(closing))("%s accepts an optional budget_usd", (type, data) => {
      expect(validateEventData(type, data).ok).toBe(true);
      const priced = validateEventData(type, { ...data, budget_usd: 0.31 });
      expect(priced).toMatchObject({ ok: true, data: { budget_usd: 0.31 } });
    });
    it.each(Object.entries(closing))("%s refuses a negative or absurd budget_usd", (type, data) => {
      expect(validateEventData(type, { ...data, budget_usd: -1 }).ok).toBe(false);
      expect(validateEventData(type, { ...data, budget_usd: 2_000_000 }).ok).toBe(false);
    });
  });

  describe("ToolIntegrity.baseline (H-14, reading 249)", () => {
    const SHA = "a".repeat(64);
    it("marks a tool hashed after an install's scripts ran, and is absent otherwise", () => {
      expect(ToolIntegritySchema.parse({ source: "project", sha256: SHA })).toEqual({
        source: "project",
        sha256: SHA,
        tampered: [],
      });
      expect(
        ToolIntegritySchema.parse({ source: "project", sha256: SHA, baseline: "after_scripts" }),
      ).toMatchObject({ baseline: "after_scripts" });
      expect(
        ToolIntegritySchema.safeParse({ source: "project", sha256: SHA, baseline: "later" })
          .success,
      ).toBe(false);
    });
  });

  describe("ReplayTrialRef.grader_bundle_sha (D-cn, reading 249)", () => {
    const ref = { proposal: "r-engineer-s-none-low-mid", task: "r1:T-1", arm: "b", trial: 1 };
    it("ties a tier replay trial's dispatch to its grader bundle, optionally", () => {
      expect(ReplayTrialRefSchema.parse({ ...ref, tier: "mid" })).not.toHaveProperty(
        "grader_bundle_sha",
      );
      expect(
        ReplayTrialRefSchema.parse({ ...ref, tier: "mid", grader_bundle_sha: "9".repeat(64) }),
      ).toMatchObject({ grader_bundle_sha: "9".repeat(64) });
      expect(ReplayTrialRefSchema.safeParse({ ...ref, grader_bundle_sha: "x" }).success).toBe(
        false,
      );
    });
  });
});
