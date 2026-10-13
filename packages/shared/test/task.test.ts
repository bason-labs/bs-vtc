import { describe, expect, it } from "vitest";
import { capForRisk, FeatureSchema, TASK_MAIN_PATH, TaskSchema } from "../src/index.js";
import { validFeature, validTask } from "./fixtures.js";
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

  it("caps follow risk", () => {
    expect([capForRisk("low"), capForRisk("med"), capForRisk("high")]).toEqual([3, 4, 5]);
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
