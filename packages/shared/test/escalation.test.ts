import { describe, expect, it } from "vitest";
import {
  EscalationAnswerSchema,
  EscalationOptionSchema,
  EscalationSchema,
  escalationFromQuestion,
  QuestionSchema,
} from "../src/index.js";
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
  it("requires a task, a feature or a run phase", () => {
    const { task: _t, ...rest } = validEscalation();
    expectInvalid(EscalationSchema, rest, "task");
  });
  it("accepts run-scoped escalations raised before PLAN", () => {
    const { task: _t, blocks: _b, ...rest } = validEscalation();
    expectValid(EscalationSchema, {
      ...rest,
      phase: "specify",
      reason: "spec_question",
      raised_by: "qa",
      options: [
        { id: "a", label: "Expire after 15 minutes", effect: "clarify" },
        { id: "b", label: "Expire after 24 hours", effect: "clarify" },
      ],
      recommended: "a",
      evidence: [{ type: "spec_ref", ref: "REQ-3.AC-2" }],
    });
    expectValid(EscalationSchema, {
      ...rest,
      phase: "intake",
      reason: "gate_infra",
      question: "Calibration could not run the test suite twice. How should we proceed?",
      options: [
        { id: "retry", label: "Retry calibration", effect: "retry" },
        { id: "hint", label: "Give the test command", effect: "hint" },
      ],
      recommended: "retry",
      evidence: [{ type: "log_line", ref: ".vtc/state/calibrate.log:88" }],
    });
  });
  it("phase is exclusive with task and feature", () => {
    expectInvalid(EscalationSchema, { ...validEscalation(), phase: "build" }, "phase");
  });
  it("names the risk rule exactly when the reason is risk_rule", () => {
    expectValid(EscalationSchema, {
      ...validEscalation(),
      reason: "risk_rule",
      risk_rule: "db_migration",
    });
    expectInvalid(EscalationSchema, { ...validEscalation(), reason: "risk_rule" }, "risk_rule");
    expectInvalid(EscalationSchema, { ...validEscalation(), risk_rule: "large_diff" }, "risk_rule");
    expectInvalid(
      EscalationSchema,
      { ...validEscalation(), reason: "risk_rule", risk_rule: "vibes" },
      "risk_rule",
    );
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

describe("QuestionSchema and escalationFromQuestion", () => {
  const question = () => ({
    question: "Should reset links expire after 15 minutes or 24 hours?",
    options: [
      { id: "short", label: "15 minutes", effect: "clarify" },
      { id: "long", label: "24 hours", effect: "clarify" },
    ],
    recommended: "short",
    evidence: [{ type: "spec_ref", ref: "REQ-3.AC-2" }],
  });
  it.each([
    ["options", { options: [{ id: "a", label: "only", effect: "clarify" }] }],
    ["recommended", { recommended: "medium" }],
    ["evidence", { evidence: [] }],
    ["question", { question: "" }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(QuestionSchema, { ...question(), ...patch }, path);
  });
  it("maps a role question to an escalation without losing anything", () => {
    const q = expectValid(QuestionSchema, question());
    const escalation = escalationFromQuestion(q, {
      id: "E-5",
      run: "r1",
      reason: "spec_question",
      task: "T-7",
      raised_by: "qa",
      created_at: NOW,
      blocks: ["T-7"],
    });
    expect(escalation).toMatchObject({
      question: q.question,
      options: q.options,
      recommended: q.recommended,
      evidence: q.evidence,
      task: "T-7",
      reason: "spec_question",
      raised_by: "qa",
      blocks: ["T-7"],
    });
    expect(EscalationSchema.parse(escalation)).toEqual(escalation);
  });
  it("refuses to build an escalation without a scope", () => {
    const q = expectValid(QuestionSchema, question());
    expect(() =>
      escalationFromQuestion(q, { id: "E-6", run: "r1", reason: "spec_question", created_at: NOW }),
    ).toThrow();
  });
});
