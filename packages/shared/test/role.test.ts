import { describe, expect, it } from "vitest";
import { estimateTokens, RoleContractSchema, RoleResultSchema } from "../src/index.js";
import { validRoleContract, validRoleResult } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("RoleResultSchema", () => {
  it("accepts a reviewer result", () => {
    expectValid(RoleResultSchema, validRoleResult());
  });
  it("accepts every exit with its required payload", () => {
    const base = { role: "engineer", task: "T-7", summary: "ok" };
    expectValid(RoleResultSchema, { ...base, exit: "built" });
    expectValid(RoleResultSchema, { ...base, exit: "unknown" });
    expectValid(RoleResultSchema, { ...base, exit: "blocked", question: "Which locale?" });
    expectValid(RoleResultSchema, {
      ...base,
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "REQ-1 contradicts REQ-2" },
    });
    expectValid(RoleResultSchema, {
      ...base,
      exit: "out_of_scope_fault",
      fault: {
        path: "src/shared/db.ts",
        line: 10,
        evidence: { type: "log_line", ref: "gate.log:88" },
        detail: "pool exhausted",
      },
    });
  });
  it.each([
    ["exit", { exit: "shipped" }],
    ["question", { exit: "blocked" }],
    ["conflict", { exit: "spec_conflict" }],
    ["fault", { exit: "out_of_scope_fault" }],
    ["verdict", { verdict: "PASS" }],
    ["role", { role: "QA" }],
    ["summary", { summary: "" }],
    ["claims.0.type", { claims: [{ type: "feeling", ref: "x" }] }],
    ["artifacts.0.path", { artifacts: [{ type: "spec", path: "/abs" }] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(RoleResultSchema, { ...validRoleResult(), ...patch }, path);
  });
  it("rejects payload fields that do not belong to the exit", () => {
    expectInvalid(RoleResultSchema, { ...validRoleResult(), question: "why?" });
  });
  it("guards the 1.5k-token summary cap", () => {
    const atCap = "x".repeat(1500 * 4);
    expect(estimateTokens(atCap)).toBe(1500);
    expectValid(RoleResultSchema, { ...validRoleResult(), summary: atCap });
    expectInvalid(RoleResultSchema, { ...validRoleResult(), summary: `${atCap}x` }, "summary");
  });
  it("out_of_scope_fault must cite a line", () => {
    expectInvalid(
      RoleResultSchema,
      {
        role: "engineer",
        summary: "x",
        exit: "out_of_scope_fault",
        fault: { path: "a.ts", evidence: { type: "log_line", ref: "l" }, detail: "d" },
      },
      "fault.line",
    );
  });
});

describe("RoleContractSchema", () => {
  it("accepts a role.yaml contract and defaults the return cap", () => {
    const role = expectValid(RoleContractSchema, validRoleContract());
    expect(role.budget.return_tokens).toBe(1500);
  });
  it("accepts an engineer profile", () => {
    expectValid(RoleContractSchema, {
      ...validRoleContract(),
      id: "engineer_frontend",
      kind: "engineer_profile",
      discipline: "frontend",
      exits: ["built", "spec_conflict", "blocked", "out_of_scope_fault"],
      reviewer: "qa",
      tools: { profile: "code_sandboxed" },
    });
  });
  it.each([
    ["version", { version: "1.0" }],
    ["kind", { kind: "persona" }],
    ["discipline", { kind: "engineer_profile" }],
    ["reviewer", { reviewer: "ba" }],
    ["inputs", { inputs: [] }],
    ["exits", { exits: [] }],
    ["exits.0", { exits: ["shipped"] }],
    ["models.codex", { models: { "claude-code": { tier: "top", effort: "high" } } }],
    [
      "models.claude-code.tier",
      {
        models: {
          "claude-code": { tier: "opus", effort: "high" },
          codex: { tier: "top", effort: "high" },
        },
      },
    ],
    ["tools.write_paths", { tools: { profile: "write_scoped" } }],
    ["tools.write_paths", { tools: { profile: "read_only", write_paths: ["x/**"] } }],
    ["tools.profile", { tools: { profile: "code_sandboxed" } }],
    ["budget.return_tokens", { budget: { context_tokens: 1000, return_tokens: 4000 } }],
    ["budget.context_tokens", { budget: { context_tokens: 0 } }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(RoleContractSchema, { ...validRoleContract(), ...patch }, path);
  });
  it("rejects persona sections (contracts, not personas)", () => {
    expectInvalid(RoleContractSchema, { ...validRoleContract(), emoji: "🤖", vibe: "chill" });
  });
});
