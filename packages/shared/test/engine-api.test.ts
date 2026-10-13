import { describe, expect, it } from "vitest";
import {
  AnswerInputSchema,
  ApproveInputSchema,
  ENGINE_HTTP,
  ENGINE_MCP_TOOLS,
  HostOutcomeSchema,
  LeadActionSchema,
  NextResultSchema,
  StartInputSchema,
  SubmitInputSchema,
} from "../src/index.js";
import { NOW, SHA, validRoleResult } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("MCP tool surface", () => {
  it("exposes the §4.2 Lead loop tools with unique names", () => {
    const names = ENGINE_MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of ["next", "submit", "status", "escalations", "answer"]) {
      expect(names).toContain(required);
    }
    for (const tool of ENGINE_MCP_TOOLS) expect(tool.purpose.length).toBeGreaterThan(10);
  });
});

describe("LeadActionSchema", () => {
  it("accepts each action type", () => {
    expectValid(NextResultSchema, {
      run: "r1",
      actions: [
        {
          type: "spawn_role",
          action_id: "a-1",
          role: "qa",
          mode: "author",
          task: "T-7",
          pack: ".vtc/state/packs/T-7.md",
          dispatch: "subagent",
        },
        { type: "ask_human", escalations: ["E-1", "E-2"] },
        { type: "approve_gate", gates: ["G1", "G2"], artifacts: [".vtc/spec/spec.md"] },
        { type: "wait", reason: "usage limit", until: NOW },
        { type: "done" },
      ],
    });
  });
  it.each([
    { type: "spawn_role", action_id: "a-1", role: "qa", pack: "/abs.md", dispatch: "subagent" },
    { type: "spawn_role", action_id: "a-1", role: "qa", pack: "p.md", dispatch: "cloud" },
    { type: "ask_human", escalations: [] },
    { type: "approve_gate", gates: ["G3"], artifacts: ["a.md"] },
    { type: "wait", reason: "x" },
    { type: "merge" },
  ])("rejects %j", (action) => {
    expectInvalid(LeadActionSchema, action);
  });
});

describe("tool inputs", () => {
  it("validates submit, answer, approve and start", () => {
    expectValid(SubmitInputSchema, { action_id: "a-1", result: validRoleResult() });
    expectInvalid(SubmitInputSchema, { result: validRoleResult() }, "action_id");
    expectValid(AnswerInputSchema, {
      escalation: "E-1",
      answer: { option: "hint", who_should_have_caught: "qa" },
    });
    expectInvalid(
      AnswerInputSchema,
      { escalation: "E-1", answer: { option: "hint" } },
      "answer.who_should_have_caught",
    );
    expectValid(ApproveInputSchema, { gates: ["G1"], decision: "approve", artifact_sha256: SHA });
    expectInvalid(
      ApproveInputSchema,
      { gates: ["G1"], decision: "maybe", artifact_sha256: SHA },
      "decision",
    );
    expectValid(StartInputSchema, { request: "Add password reset", track: "feature" });
    expectInvalid(StartInputSchema, { request: "" }, "request");
  });
});

describe("HostOutcomeSchema", () => {
  it("normalises to done | limit | auth | error", () => {
    expectValid(HostOutcomeSchema, {
      kind: "done",
      session_ref: { host: "claude-code", id: "s" },
      output: { exit: "built" },
      model: "claude-sonnet-5",
      tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
      cost_usd: 0.01,
    });
    expectValid(HostOutcomeSchema, {
      kind: "limit",
      session_ref: null,
      resets_at: null,
      window: null,
      model: null,
      message: "limit",
    });
    expectValid(HostOutcomeSchema, { kind: "auth", message: "logged out" });
    expectValid(HostOutcomeSchema, { kind: "error", message: "boom", retryable: false });
    expectInvalid(HostOutcomeSchema, { kind: "timeout", message: "x" });
    expectInvalid(HostOutcomeSchema, { kind: "error", message: "x" }, "retryable");
  });
});

describe("HTTP API", () => {
  it("binds to loopback and keeps every route under /api", () => {
    expect(ENGINE_HTTP.bindHost).toBe("127.0.0.1");
    const routes = Object.values(ENGINE_HTTP.routes);
    for (const route of routes) expect(route.path.startsWith("/api/")).toBe(true);
    const writes = routes.filter((r) => r.method !== "GET");
    expect(writes.map((r) => r.path)).toEqual(["/api/ingest/claude-statusline"]);
  });
});
