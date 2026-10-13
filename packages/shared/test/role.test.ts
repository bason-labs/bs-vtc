import { describe, expect, it } from "vitest";
import {
  estimateTokens,
  resolveRoleMode,
  RoleContractSchema,
  RoleResultSchema,
  SUMMARY_MAX_CHARS,
  type RoleContract,
} from "../src/index.js";
import { validRoleContract, validRoleResult, validTaskDraft } from "./fixtures.js";

const question = () => ({
  question: "Which locale formats the reset email?",
  options: [
    { id: "en", label: "English only", effect: "clarify" },
    { id: "user", label: "The user's locale", effect: "clarify" },
  ],
  recommended: "user",
  evidence: [{ type: "spec_ref", ref: "REQ-3.AC-2" }],
});
import { expectInvalid, expectValid } from "./helpers.js";

describe("RoleResultSchema", () => {
  it("accepts a reviewer result", () => {
    expectValid(RoleResultSchema, validRoleResult());
  });
  it("accepts every exit with its required payload", () => {
    const base = { role: "engineer", task: "T-7", summary: "ok" };
    expectValid(RoleResultSchema, { ...base, exit: "built" });
    expectValid(RoleResultSchema, { ...base, exit: "unknown" });
    expectValid(RoleResultSchema, { ...base, exit: "blocked", question: question() });
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
  it("blocked carries a full question with options, not a bare string", () => {
    expectInvalid(
      RoleResultSchema,
      { role: "engineer", summary: "x", exit: "blocked", question: "Which locale?" },
      "question",
    );
  });
  it("lets QA raise spec questions while finishing (exit done)", () => {
    const result = expectValid(RoleResultSchema, {
      ...validRoleResult(),
      role: "qa",
      mode: "author",
      questions: [question()],
    });
    expect(result.questions).toHaveLength(1);
    expect(expectValid(RoleResultSchema, validRoleResult()).questions).toEqual([]);
  });
  it("accepts planner task drafts", () => {
    expectValid(RoleResultSchema, {
      role: "planner",
      exit: "done",
      summary: "Two tasks.",
      tasks: [validTaskDraft(), { ...validTaskDraft(), id: "T-8", after: ["T-7"] }],
    });
  });
  it("represents Visual QA's unchecked verdict and question type", () => {
    expectValid(RoleResultSchema, {
      ...validRoleResult(),
      role: "visual_qa",
      verdict: "unchecked",
      question_type: "state",
    });
    expectInvalid(
      RoleResultSchema,
      { ...validRoleResult(), question_type: "vibes" },
      "question_type",
    );
  });
  it("summary cap is also a plain maxLength", () => {
    expect(SUMMARY_MAX_CHARS).toBe(6000);
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
  it("rejects code_sandboxed in a mode of a non-engineer role", () => {
    expectInvalid(
      RoleContractSchema,
      { ...validRoleContract(), modes: { hack: { tools: { profile: "code_sandboxed" } } } },
      "modes.hack.tools.profile",
    );
    expectInvalid(RoleContractSchema, { ...validRoleContract(), modes: {} }, "modes");
  });
  it("rejects persona sections (contracts, not personas)", () => {
    expectInvalid(RoleContractSchema, { ...validRoleContract(), emoji: "🤖", vibe: "chill" });
  });
});

describe("role modes", () => {
  const qa = (): RoleContract =>
    RoleContractSchema.parse({
      ...validRoleContract(),
      id: "qa",
      reviewer: "engineer",
      mission: "Author acceptance tests before the Engineer; judge test adequacy after.",
      inputs: ["task_pack"],
      tools: { profile: "read_only" },
      modes: {
        author: {
          tools: { profile: "write_scoped", write_paths: ["test/acceptance/**"] },
          output: { artifacts: ["acceptance_tests"] },
        },
        judge: { output: { verdicts: ["pass", "fail", "unknown"] } },
      },
    });
  it("QA author writes acceptance tests only; judge is read-only", () => {
    const author = resolveRoleMode(qa(), "author");
    const judge = resolveRoleMode(qa(), "judge");
    expect(author.ok && author.contract.tools).toEqual({
      profile: "write_scoped",
      write_paths: ["test/acceptance/**"],
      engine_tools: [],
    });
    expect(judge.ok && judge.contract.tools.profile).toBe("read_only");
    expect(judge.ok && judge.contract.inputs).toEqual(["task_pack"]);
  });
  it("a role with modes needs a declared mode; a role without modes takes none", () => {
    expect(resolveRoleMode(qa()).ok).toBe(false);
    expect(resolveRoleMode(qa(), "reviewer").ok).toBe(false);
    const ba = RoleContractSchema.parse(validRoleContract());
    expect(resolveRoleMode(ba).ok).toBe(true);
    expect(resolveRoleMode(ba, "author").ok).toBe(false);
  });
});
