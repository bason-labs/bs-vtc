import { describe, expect, it } from "vitest";
import {
  capForRisk,
  DEPENDENCY_RELEASED_STATUSES,
  FeatureSchema,
  integrationBranchFor,
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
      feature: "F-1",
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
      origin: "planner",
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
    ["after", { after: ["T-3", "T-3"] }],
    ["feature", { feature: undefined }],
    ["source_finding", { source_finding: SHA }],
    ["origin", { origin: "lookback" }],
    ["park_reason", { status: "parked" }],
    ["park_reason", { park_reason: "cap" }],
    ["risk_rule", { status: "parked", park_reason: "risk_rule" }],
    ["risk_rule", { status: "parked", park_reason: "cap", risk_rule: "large_diff" }],
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

  it("a risk-rule park names the rule, so nothing joins against escalations", () => {
    const parked = { ...validTask(), status: "parked", park_reason: "risk_rule" };
    expect(expectValid(TaskSchema, { ...parked, risk_rule: "db_migration" }).risk_rule).toBe(
      "db_migration",
    );
  });

  it("engine-created tasks name their source finding and may cover no REQ (§6.7a)", () => {
    const fix = { ...validTask(), origin: "integration_fix", source_finding: SHA, covers: [] };
    expect(expectValid(TaskSchema, fix).origin).toBe("integration_fix");
    expectValid(TaskSchema, { ...fix, origin: "out_of_scope" });
    expectInvalid(TaskSchema, { ...fix, source_finding: undefined }, "source_finding");
    expectInvalid(TaskSchema, { ...fix, origin: "planner", source_finding: undefined }, "covers");
  });

  it("a contract provider is released by contract.frozen, never also by after (§6.6)", () => {
    expect(DEPENDENCY_RELEASED_STATUSES).toEqual(["merged", "done"]);
    const consumer = {
      ...validTask(),
      consumes_contracts: [{ provider: "T-2", kind: "openapi", path: "contracts/api.yaml" }],
    };
    expectValid(TaskSchema, consumer);
    expectInvalid(TaskSchema, { ...consumer, after: ["T-2"] }, "consumes_contracts.0.provider");
    const draft = {
      ...validTaskDraft(),
      after: [],
      consumes_contracts: consumer.consumes_contracts,
    };
    expectValid(TaskDraftSchema, draft);
    expectInvalid(TaskDraftSchema, { ...draft, after: ["T-2"] }, "consumes_contracts.0.provider");
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
    ["pr.url", { pr: { ...validFeature().pr, url: "not a url" } }],
    ["pr.ci", { pr: { ...validFeature().pr, ci: "passing" } }],
    ["pr.merge_commit", { pr: { ...validFeature().pr, state: "merged" } }],
    ["pr.merge_commit", { pr: { ...validFeature().pr, merge_commit: COMMIT } }],
    ["status", { status: "merged" }],
    ["integration_branch", { integration_branch: "vtc/F-2" }],
    ["integration_branch", { integration_branch: "feature/reset" }],
    ["risk_rule", { status: "parked", park_reason: "risk_rule" }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(FeatureSchema, { ...validFeature(), ...patch }, path);
  });
  it("records the Level-3 merge into main on the PR (§6.7)", () => {
    const merged = { ...validFeature().pr, state: "merged", ci: "green", merge_commit: COMMIT };
    expect(expectValid(FeatureSchema, { ...validFeature(), pr: merged }).pr?.state).toBe("merged");
    expect(integrationBranchFor("F-3")).toBe("vtc/F-3");
    expect(() => integrationBranchFor("T-3")).toThrow();
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
    ["feature", { feature: "F-1" }],
    ["origin", { origin: "planner" }],
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
