import { describe, it } from "vitest";
import { EscalationAnswerSchema, EscalationOptionSchema, EscalationSchema } from "../src/index.js";
import { NOW, validEscalation } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("EscalationSchema", () => {
  it("accepts an open escalation", () => {
    expectValid(EscalationSchema, validEscalation());
  });
  it("accepts an answered escalation", () => {
    expectValid(EscalationSchema, {
      ...validEscalation(),
      answer: {
        option: "hint",
        text: "Bind the token to user id",
        who_should_have_caught: "architect",
      },
      answered_at: NOW,
    });
  });
  it("accepts a spec_question on a feature", () => {
    const { task: _t, ...rest } = validEscalation();
    expectValid(EscalationSchema, {
      ...rest,
      feature: "F-1",
      reason: "spec_question",
      options: [
        { id: "a", label: "Tokens expire after 15 minutes", effect: "clarify" },
        { id: "b", label: "Tokens expire after 24 hours", effect: "clarify" },
      ],
      recommended: "a",
      evidence: [{ type: "spec_ref", ref: "REQ-3" }],
    });
  });
  it.each([
    ["options", { options: [{ id: "a", label: "only", effect: "hint" }], recommended: "a" }],
    ["recommended", { recommended: "nope" }],
    ["reason", { reason: "vibes" }],
    ["evidence", { evidence: [] }],
    ["question", { question: "" }],
    ["answered_at", { answer: { option: "hint", who_should_have_caught: "qa" } }],
    ["answered_at", { answered_at: NOW }],
    [
      "answer.option",
      { answer: { option: "zzz", who_should_have_caught: "qa" }, answered_at: NOW },
    ],
    ["blocks.0", { blocks: ["X-1"] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(EscalationSchema, { ...validEscalation(), ...patch }, path);
  });
  it("requires a task or feature", () => {
    const { task: _t, ...rest } = validEscalation();
    expectInvalid(EscalationSchema, rest, "task");
  });
  it("rejects duplicate option ids and more than 4 options", () => {
    const opt = { id: "a", label: "x", effect: "hint" };
    expectInvalid(
      EscalationSchema,
      { ...validEscalation(), options: [opt, opt], recommended: "a" },
      "options",
    );
    const many = ["a", "b", "c", "d", "e"].map((id) => ({ id, label: id, effect: "hint" }));
    expectInvalid(
      EscalationSchema,
      { ...validEscalation(), options: many, recommended: "a" },
      "options",
    );
  });
});

describe("EscalationOptionSchema", () => {
  it.each([
    ["budget_factor", { id: "r", label: "raise", effect: "raise_budget" }],
    ["budget_factor", { id: "r", label: "raise", effect: "raise_budget", budget_factor: 2.5 }],
    ["budget_factor", { id: "r", label: "raise", effect: "raise_budget", budget_factor: 1 }],
    ["budget_factor", { id: "h", label: "hint", effect: "hint", budget_factor: 1.5 }],
    ["waiver_expires_at", { id: "w", label: "waive", effect: "waive" }],
  ])("enforces effect parameters (%s)", (path, option) => {
    expectInvalid(EscalationOptionSchema, option, path);
  });
  it("accepts raise_budget up to 2x", () => {
    expectValid(EscalationOptionSchema, {
      id: "r",
      label: "raise",
      effect: "raise_budget",
      budget_factor: 2,
    });
  });
});

describe("EscalationAnswerSchema", () => {
  it("requires who_should_have_caught", () => {
    expectInvalid(EscalationAnswerSchema, { option: "a" }, "who_should_have_caught");
    expectValid(EscalationAnswerSchema, { option: "a", who_should_have_caught: "none" });
  });
});
