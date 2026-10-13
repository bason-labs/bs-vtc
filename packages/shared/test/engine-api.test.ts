import { describe, expect, it } from "vitest";
import {
  AnswerInputSchema,
  ApproveInputSchema,
  ChangeRequestInputSchema,
  ChangeRequestResultSchema,
  CONTRACT_SCHEMAS,
  DesignReviewCommentInputSchema,
  DesignReviewResultSchema,
  ENGINE_HTTP,
  ENGINE_MCP_TOOLS,
  HostFailureOutcomeSchema,
  HostOutcomeSchema,
  isContractName,
  LeadActionSchema,
  NextResultSchema,
  RunControlResultSchema,
  RunScopedInputSchema,
  StartInputSchema,
  StartResultSchema,
  SubmitInputSchema,
  SubmitResultSchema,
} from "../src/index.js";
import { NOW, SHA, validRoleResult } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

const spawn = () => ({
  type: "spawn_role",
  action_id: "a-1",
  role: "qa",
  mode: "author",
  task: "T-7",
  pack: ".vtc/state/packs/T-7.md",
  agent: "vtc-qa-author",
  prompt: "Read the task pack at .vtc/state/packs/T-7.md and follow it.",
  background: true,
});

describe("MCP tool surface", () => {
  it("exposes the §4.2 Lead loop tools with unique names", () => {
    const names = ENGINE_MCP_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of ["next", "submit", "status", "escalations", "answer"]) {
      expect(names).toContain(required);
    }
    for (const tool of ENGINE_MCP_TOOLS) expect(tool.purpose.length).toBeGreaterThan(10);
  });
  it.each(ENGINE_MCP_TOOLS.map((t) => [t.name, t.input, t.output] as const))(
    "tool %s names existing input (%s) and output (%s) contracts",
    (_name, input, output) => {
      expect(isContractName(input)).toBe(true);
      expect(isContractName(output)).toBe(true);
    },
  );
});

describe("LeadActionSchema", () => {
  it("accepts each action type", () => {
    expectValid(NextResultSchema, {
      run: "r1",
      actions: [
        spawn(),
        { ...spawn(), action_id: "a-2", resume: { host: "claude-code", id: "s-1" } },
        { type: "ask_human", escalations: ["E-1", "E-2"] },
        {
          type: "approve_gate",
          gates: ["G1", "G2"],
          artifacts: [
            { path: ".vtc/spec/spec.md", sha256: SHA },
            { path: ".vtc/architecture/spine.md", sha256: "b".repeat(64) },
          ],
          design_directions: ["calm-ledger", "night-market"],
          unverified_facts: ["fact-12"],
        },
        { type: "wait", reason: "usage limit", until: NOW },
        { type: "done" },
      ],
    });
  });
  it.each([
    [{ ...spawn(), pack: "/abs.md" }],
    [{ ...spawn(), dispatch: "headless" }],
    [{ ...spawn(), agent: "" }],
    [(({ prompt: _p, ...rest }) => rest)(spawn())],
    [{ ...spawn(), background: "yes" }],
    [{ type: "ask_human", escalations: [] }],
    [{ type: "approve_gate", gates: ["G3"], artifacts: [{ path: "a.md", sha256: SHA }] }],
    [{ type: "approve_gate", gates: ["G1"], artifacts: ["a.md"] }],
    [{ type: "approve_gate", gates: ["G1", "G2", "G1"], artifacts: [{ path: "a", sha256: SHA }] }],
    [{ type: "wait", reason: "x" }],
    [{ type: "merge" }],
  ])("rejects %j", (action) => {
    expectInvalid(LeadActionSchema, action);
  });
  it("NextResult requires a valid run id", () => {
    expectInvalid(NextResultSchema, { run: "../r", actions: [] }, "run");
    expectInvalid(NextResultSchema, { actions: [] }, "run");
  });
});

describe("start", () => {
  const start = () => ({
    request: "Add password reset",
    track: "feature",
    repo: "existing",
    has_ui: true,
    risk_hints: ["auth"],
  });
  it("carries the Lead's intake classification", () => {
    expectValid(StartInputSchema, start());
    expectValid(StartResultSchema, { run: "r1", track: "feature", phase: "intake" });
  });
  it.each([
    ["request", { request: "" }],
    ["track", { track: undefined }],
    ["repo", { repo: "fork" }],
    ["has_ui", { has_ui: "yes" }],
    ["risk_hints.0", { risk_hints: ["Not A Slug"] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(StartInputSchema, { ...start(), ...patch }, path);
  });
});

describe("submit", () => {
  it("accepts a result with optional usage", () => {
    expectValid(SubmitInputSchema, { kind: "result", action_id: "a-1", result: validRoleResult() });
    expectValid(SubmitInputSchema, {
      kind: "result",
      run: "r1",
      action_id: "a-1",
      result: validRoleResult(),
      usage: {
        model: "claude-sonnet-5",
        tokens: { in: 10, out: 5, cache_r: 0, cache_w: 0 },
        cost_usd: null,
      },
    });
  });
  it("accepts a limit, auth or error outcome instead of a result", () => {
    const limit = {
      kind: "limit",
      session_ref: { host: "claude-code", id: "s" },
      resets_at: NOW,
      window: "five_hour",
      model: null,
      message: "limit reached",
      tokens: { in: 100, out: 10, cache_r: 0, cache_w: 0 },
      cost_usd: 0.02,
    };
    expectValid(SubmitInputSchema, { kind: "failure", action_id: "a-1", outcome: limit });
    expectValid(SubmitInputSchema, {
      kind: "failure",
      action_id: "a-1",
      outcome: { kind: "auth", message: "logged out" },
    });
  });
  it.each([
    ["action_id", { kind: "result", result: validRoleResult() }],
    ["kind", { action_id: "a-1", result: validRoleResult() }],
    ["outcome", { kind: "failure", action_id: "a-1" }],
    [
      "outcome.kind",
      { kind: "failure", action_id: "a-1", outcome: { kind: "done", session_ref: null } },
    ],
    [
      "usage.cost_usd",
      {
        kind: "result",
        action_id: "a-1",
        result: validRoleResult(),
        usage: { model: null, tokens: null, cost_usd: -1 },
      },
    ],
  ])("rejects invalid %s", (path, value) => {
    expectInvalid(SubmitInputSchema, value, path);
  });
  it("a done outcome is not a failure", () => {
    expectInvalid(HostFailureOutcomeSchema, {
      kind: "done",
      session_ref: null,
      output: {},
      model: null,
      tokens: null,
      cost_usd: null,
    });
  });
  it("SubmitResult carries a rejection exactly when not accepted", () => {
    expectValid(SubmitResultSchema, { run: "r1", accepted: true, actions: [] });
    expectValid(SubmitResultSchema, {
      run: "r1",
      accepted: false,
      rejection: { reason: "stale_action", issues: ["action a-1 was superseded"] },
      actions: [],
    });
    expectInvalid(SubmitResultSchema, { run: "r1", accepted: false, actions: [] }, "rejection");
    expectInvalid(
      SubmitResultSchema,
      { run: "r1", accepted: true, rejection: { reason: "schema" }, actions: [] },
      "rejection",
    );
  });
});

describe("answer, approve, change_request and run control", () => {
  it("validates answer", () => {
    expectValid(AnswerInputSchema, {
      escalation: "E-1",
      answer: { option: "hint", who_should_have_caught: "qa" },
    });
    expectInvalid(
      AnswerInputSchema,
      { escalation: "E-1", answer: { option: "hint" } },
      "answer.who_should_have_caught",
    );
  });
  const approve = () => ({
    gates: ["G1"],
    decision: "approve",
    frozen: [{ path: ".vtc/spec/spec.md", sha256: SHA }],
  });
  it("freezes every shown artifact at its own hash, G1+G2 together on quick fix", () => {
    expectValid(ApproveInputSchema, approve());
    expectValid(ApproveInputSchema, {
      gates: ["G1", "G2"],
      decision: "approve",
      frozen: [
        { path: ".vtc/spec/spec.md", sha256: SHA },
        { path: ".vtc/architecture/spine.md", sha256: "b".repeat(64) },
        { path: ".vtc/design/DESIGN.md", sha256: "c".repeat(64) },
      ],
      design_direction: "calm-ledger",
      waived_facts: ["fact-3"],
    });
  });
  it.each([
    ["decision", { decision: "maybe" }],
    ["gates", { gates: [] }],
    ["gates", { gates: ["G1", "G2", "G2"] }],
    ["gates", { gates: ["G1", "G1"] }],
    ["frozen", { frozen: [] }],
    ["frozen.0.sha256", { frozen: [{ path: "a.md", sha256: "abc" }] }],
    [
      "frozen",
      {
        frozen: [
          { path: "a.md", sha256: SHA },
          { path: "a.md", sha256: "b".repeat(64) },
        ],
      },
    ],
    ["design_direction", { design_direction: "calm-ledger" }],
    ["design_direction", { waived_facts: ["fact-1"] }],
    ["design_direction", { gates: ["G2"], decision: "reject", design_direction: "calm-ledger" }],
    ["", { artifact_sha256: SHA }],
  ])("rejects invalid approve (%s)", (path, patch) => {
    expectInvalid(ApproveInputSchema, { ...approve(), ...patch }, path);
  });
  it("validates change requests", () => {
    expectValid(ChangeRequestInputSchema, {
      artifact: "spec",
      summary: "Tokens expire after 15 minutes",
      detail: "Security asked for a shorter expiry.",
    });
    expectValid(ChangeRequestResultSchema, { run: "r1", escalation: "E-3" });
  });
  it.each([
    ["artifact", { artifact: "code" }],
    ["summary", { summary: "" }],
    ["summary", { summary: "x".repeat(301) }],
    ["detail", { detail: "" }],
    ["run", { run: "a/b" }],
  ])("rejects invalid change request %s", (path, patch) => {
    expectInvalid(
      ChangeRequestInputSchema,
      { artifact: "design", summary: "s", detail: "d", ...patch },
      path,
    );
  });
  it("run-scoped tools take an optional, path-safe run id", () => {
    expectValid(RunScopedInputSchema, {});
    expectValid(RunScopedInputSchema, { run: "run-2026-10-13" });
    expectInvalid(RunScopedInputSchema, { run: "../x" }, "run");
    expectInvalid(RunScopedInputSchema, { run: "r1", extra: true });
    expectValid(RunControlResultSchema, { run: "r1", paused: true, phase: "build" });
    expectInvalid(RunControlResultSchema, { run: "r1", paused: true, phase: "deploy" }, "phase");
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
      tokens: null,
      cost_usd: null,
    });
    expectValid(HostOutcomeSchema, { kind: "auth", message: "logged out" });
    expectValid(HostOutcomeSchema, {
      kind: "error",
      message: "boom",
      retryable: false,
      tokens: null,
      cost_usd: null,
    });
    expectInvalid(HostOutcomeSchema, { kind: "timeout", message: "x" });
    expectInvalid(
      HostOutcomeSchema,
      { kind: "error", message: "x", tokens: null, cost_usd: null },
      "retryable",
    );
    expectInvalid(
      HostOutcomeSchema,
      {
        kind: "limit",
        session_ref: null,
        resets_at: null,
        window: "seven_day",
        model: null,
        message: "limit",
        tokens: null,
        cost_usd: null,
      },
      "window",
    );
  });
});

describe("HTTP API", () => {
  const routes = Object.values(ENGINE_HTTP.routes);
  it("binds to loopback and keeps every route under /api", () => {
    expect(ENGINE_HTTP.bindHost).toBe("127.0.0.1");
    for (const route of routes) expect(route.path.startsWith("/api/")).toBe(true);
  });
  it("has exactly two writes, both size-limited and validated", () => {
    const writes = routes.filter((r) => r.method !== "GET");
    expect(writes.map((r) => r.path).sort()).toEqual([
      "/api/design/reviews",
      "/api/ingest/claude-statusline",
    ]);
    for (const write of writes) {
      expect("request" in write && isContractName(write.request)).toBe(true);
      expect("maxBodyBytes" in write && write.maxBodyBytes > 0).toBe(true);
    }
  });
  it.each(Object.entries(ENGINE_HTTP.routes))(
    "route %s names an existing response contract",
    (_n, route) => {
      expect(isContractName(route.response)).toBe(true);
      expect(CONTRACT_SCHEMAS[route.response]).toBeDefined();
    },
  );
  it("design review pins stay under .vtc/design/reviews/", () => {
    expectValid(DesignReviewCommentInputSchema, {
      screen: "checkout",
      state: "error",
      viewport: 390,
      theme: "dark",
      x_pct: 12.5,
      y_pct: 80,
      comment: "The error text is clipped.",
    });
    expectInvalid(
      DesignReviewCommentInputSchema,
      {
        screen: "../x",
        state: "e",
        viewport: 390,
        theme: "dark",
        x_pct: 1,
        y_pct: 1,
        comment: "c",
      },
      "screen",
    );
    expectInvalid(
      DesignReviewCommentInputSchema,
      { screen: "s", state: "e", viewport: 390, theme: "dark", x_pct: 101, y_pct: 1, comment: "c" },
      "x_pct",
    );
    expectValid(DesignReviewResultSchema, { ok: true, path: ".vtc/design/reviews/checkout.jsonl" });
    expectInvalid(DesignReviewResultSchema, { ok: true, path: ".vtc/spec/spec.md" }, "path");
  });
});
