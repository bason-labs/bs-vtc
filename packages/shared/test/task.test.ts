import { describe, expect, it } from "vitest";
import {
  capForRisk,
  FeatureSchema,
  PlanFileFrontmatterSchema,
  ProjectConfigSchema,
  TASK_MAIN_PATH,
  TaskDraftSchema,
  TaskSchema,
} from "../src/index.js";
import { COMMIT, SHA, validFeature, validTask, validTaskDraft } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("TaskSchema", () => {
  it("accepts a full task", () => {
    const task = expectValid(TaskSchema, validTask());
    expect(task.status).toBe("fixing");
  });

  it("applies defaults for a minimal task", () => {
    const task = expectValid(TaskSchema, {
      id: "T-1",
      title: "x",
      covers: ["REQ-1"],
      files_scope: ["src/**"],
      discipline: "frontend",
      risk: "low",
      cap: 3,
      size: "S",
      arch_triage: "fits",
      budget_usd: 1.5,
      status: "draft",
    });
    expect(task).toMatchObject({
      after: [],
      stack_packs: [],
      consumes_contracts: [],
      spent_usd: 0,
      round: 0,
      deferred: [],
    });
  });

  it.each([
    ["covers", { covers: [] }],
    ["files_scope", { files_scope: [] }],
    ["files_scope.0", { files_scope: ["/abs/**"] }],
    ["stack_packs", { stack_packs: ["a", "b", "c", "d"] }],
    ["cap", { cap: 6 }],
    ["cap", { cap: 2 }],
    ["risk", { risk: "medium" }],
    ["discipline", { discipline: "fullstack" }],
    ["status", { status: "parked(cap)" }],
    ["budget_usd", { budget_usd: 0 }],
    ["round", { round: 6 }],
    ["after", { after: ["T-7"] }],
    ["park_reason", { status: "parked" }],
    ["park_reason", { park_reason: "cap" }],
    ["branch", { branch: "vtc/T-8" }],
    ["branch", { branch: "feature/x" }],
    [
      "consumes_contracts.0.provider",
      { consumes_contracts: [{ provider: "T-7", kind: "openapi", path: "a.yaml" }] },
    ],
    ["provides_contract.kind", { provides_contract: { kind: "soap", path: "a.wsdl" } }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(TaskSchema, { ...validTask(), ...patch }, path);
  });

  it("accepts parked with a reason", () => {
    expectValid(TaskSchema, { ...validTask(), status: "parked", park_reason: "stuck" });
  });

  it("rejects unknown keys (strict contract)", () => {
    expectInvalid(TaskSchema, { ...validTask(), owner: "bob" });
  });

  it("caps come from project.yaml only (one source of defaults)", () => {
    const { caps } = ProjectConfigSchema.parse({ version: 1 });
    expect([capForRisk("low", caps), capForRisk("med", caps), capForRisk("high", caps)]).toEqual([
      3, 4, 5,
    ]);
    const custom = ProjectConfigSchema.parse({ version: 1, caps: { high: 4 } }).caps;
    expect(capForRisk("high", custom)).toBe(4);
  });

  it("keeps the planner's risk tags on the task, so replay does not lose them", () => {
    expect(expectValid(TaskSchema, validTask()).risk_tags).toEqual([]);
    expect(expectValid(TaskSchema, { ...validTask(), risk_tags: ["auth"] }).risk_tags).toEqual([
      "auth",
    ]);
    expectInvalid(TaskSchema, { ...validTask(), risk_tags: ["Auth Flow"] }, "risk_tags.0");
  });

  it("main path is ordered and ends in done", () => {
    expect(TASK_MAIN_PATH[0]).toBe("draft");
    expect(TASK_MAIN_PATH.at(-1)).toBe("done");
  });
});

describe("FeatureSchema", () => {
  it("accepts a feature in final review", () => {
    expectValid(FeatureSchema, validFeature());
  });
  it.each([
    ["round", { round: 4 }],
    ["tasks", { tasks: [] }],
    ["tasks", { tasks: ["T-1", "T-1"] }],
    ["park_reason", { status: "parked" }],
    ["park_reason", { park_reason: "cap" }],
    ["final_review_budget_usd", { final_review_budget_usd: 25 }],
    ["pr.url", { pr: { url: "not a url", draft: true } }],
    ["status", { status: "merged" }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(FeatureSchema, { ...validFeature(), ...patch }, path);
  });
});

describe("task worktree and baseline", () => {
  it("keeps machine paths and short SHAs out of the git-tracked record", () => {
    expectInvalid(TaskSchema, { ...validTask(), worktree: "/tmp/wt/T-7" }, "worktree");
    expectInvalid(
      TaskSchema,
      { ...validTask(), baseline_revision: "0123abcd" },
      "baseline_revision",
    );
    expectValid(TaskSchema, { ...validTask(), baseline_revision: COMMIT });
  });
});

describe("TaskDraftSchema (Planner output)", () => {
  it("accepts a draft with its intent contract", () => {
    const draft = expectValid(TaskDraftSchema, validTaskDraft());
    expect(draft.intent.io_matrix).toHaveLength(1);
  });
  it.each([
    ["status", { status: "ready" }],
    ["cap", { cap: 5 }],
    ["budget_usd", { budget_usd: 100 }],
    ["round", { round: 0 }],
    ["spent_usd", { spent_usd: 0 }],
    ["worktree", { worktree: ".vtc/state/worktrees/T-7" }],
    ["branch", { branch: "vtc/T-7" }],
    ["deferred", { deferred: [] }],
    ["baseline_revision", { baseline_revision: COMMIT }],
  ])("rejects the engine-owned field %s", (_field, patch) => {
    expectInvalid(TaskDraftSchema, { ...validTaskDraft(), ...patch }, "");
  });
  it.each([
    ["intent", { intent: undefined }],
    ["intent.io_matrix", { intent: { statement: "x", io_matrix: [] } }],
    [
      "provides_contract",
      { provides_contract: { kind: "openapi", path: "a.yaml", frozen_sha256: SHA } },
    ],
    ["after", { after: ["T-7"] }],
    ["stack_packs", { stack_packs: ["a", "b", "c", "d"] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(TaskDraftSchema, { ...validTaskDraft(), ...patch }, path);
  });
});

describe("PlanFileFrontmatterSchema", () => {
  it("is the engine's task projection", () => {
    expect(PlanFileFrontmatterSchema).toBe(TaskSchema);
    expectValid(PlanFileFrontmatterSchema, validTask());
  });
});
