import { describe, expect, it } from "vitest";
import { FindingDraftSchema, FindingSchema } from "../src/index.js";
import { validFinding, validFindingDraft } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("FindingDraftSchema", () => {
  it("accepts a reviewer draft", () => {
    expectValid(FindingDraftSchema, validFindingDraft());
  });
  it("defaults req_ids", () => {
    const { req_ids: _omit, ...rest } = validFindingDraft();
    expect(expectValid(FindingDraftSchema, rest).req_ids).toEqual([]);
  });
  it.each([
    ["confidence", { confidence: 1.5 }],
    ["category", { category: "style" }],
    ["evidence.type", { evidence: { type: "vibes", ref: "x" } }],
    ["evidence.ref", { evidence: { type: "file_line", ref: "" } }],
    ["location.path", { location: { path: "../outside.ts" } }],
    ["req_ids.0", { req_ids: ["AC-1"] }],
    ["title", { title: "" }],
    ["claimed_severity", { claimed_severity: "blocker" }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(FindingDraftSchema, { ...validFindingDraft(), ...patch }, path);
  });
  it("rejects engine-owned fields from reviewers", () => {
    expectInvalid(FindingDraftSchema, { ...validFindingDraft(), severity: "low" });
  });
});

describe("FindingSchema", () => {
  it("accepts an engine finding", () => {
    expectValid(FindingSchema, validFinding());
  });
  it("accepts every route", () => {
    for (const route of [
      "patch",
      "spec_gap",
      "design_gap",
      "bad_test",
      "risky",
      "defer",
      "out_of_scope",
    ]) {
      expectValid(FindingSchema, { ...validFinding(), route });
    }
  });
  it("accepts out_of_scope with an owner task", () => {
    expectValid(FindingSchema, { ...validFinding(), route: "out_of_scope", owner_task: "T-2" });
  });
  it("accepts a waived finding with an expiring waiver", () => {
    expectValid(FindingSchema, {
      ...validFinding(),
      status: "waived",
      waiver: { by: "human", reason: "accepted risk", expires_at: "2026-12-01T00:00:00Z" },
    });
  });
  it.each([
    ["fingerprint", { fingerprint: "abc" }],
    ["severity", { severity: "blocker" }],
    ["route", { route: "ignore" }],
    ["status", { status: "fixed" }],
    ["source", { source: "human" }],
    ["round_first_seen", { round_first_seen: 0 }],
    ["round_last_seen", { round_first_seen: 3, round_last_seen: 2 }],
    ["waiver", { status: "waived" }],
    ["owner_task", { owner_task: "T-2" }],
    [
      "waiver.by",
      {
        status: "waived",
        waiver: { by: "engine", reason: "x", expires_at: "2026-12-01T00:00:00Z" },
      },
    ],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(FindingSchema, { ...validFinding(), ...patch }, path);
  });
});
