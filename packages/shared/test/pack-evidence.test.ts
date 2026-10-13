import { describe, expect, it } from "vitest";
import {
  EvidenceBundleSchema,
  evidenceBundlePath,
  renderTaskPack,
  TASK_PACK_SECTIONS,
  TaskPackSchema,
  taskPackPath,
  TraceabilityReportSchema,
} from "../src/index.js";
import { NOW, SHA, validFinding, validTaskDraft } from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

const report = () => ({
  run: "r1",
  task: "T-7",
  rows: [
    {
      req: "REQ-3.AC-1",
      tests: [{ id: "reset sends mail [REQ-3.AC-1]", status: "pass", provenance: "spec" }],
      covered: true,
    },
    {
      req: "REQ-3.AC-2",
      tests: [{ id: "reset expires [REQ-3.AC-2]", status: "fail", hidden: true }],
      covered: false,
    },
  ],
  gaps: ["REQ-3.AC-2"],
  scope_creep: ["src/unrelated.ts"],
  built_at: NOW,
});

describe("TraceabilityReportSchema (§7.4)", () => {
  it("accepts a report with a gap and a scope-creep flag", () => {
    const parsed = expectValid(TraceabilityReportSchema, report());
    expect(parsed.rows[1]?.tests[0]?.hidden).toBe(true);
  });
  it.each([
    ["rows.0.covered", { rows: [{ ...report().rows[0], covered: false }], gaps: ["REQ-3.AC-1"] }],
    ["gaps", { gaps: [] }],
    ["task", { feature: "F-1" }],
    ["task", { task: undefined }],
    ["scope_creep.0", { scope_creep: ["/abs.ts"] }],
    [
      "rows.0.tests.0.status",
      { rows: [{ ...report().rows[0], tests: [{ id: "t", status: "ok" }] }] },
    ],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(TraceabilityReportSchema, { ...report(), ...patch }, path);
  });
});

describe("EvidenceBundleSchema (§6.7a, §14)", () => {
  const spend = { usd: 4.4, tokens: { in: 1, out: 2, cache_r: 3, cache_w: 4 } };
  const counts = { open: 0, resolved: 2, deferred: 1, waived: 0, discarded: 1 };
  const task = () => ({
    kind: "task",
    run: "r1",
    task: "T-7",
    feature: "F-1",
    discipline: "backend",
    rounds: 2,
    cap: 5,
    traceability: report(),
    findings: counts,
    gate_reports: [".vtc/evidence/T-7/round-2/junit.xml"],
    verdicts: [{ role: "spec_verifier", subject: "REQ-3.AC-1", verdict: "pass", prompt_sha: SHA }],
    spend,
    written_at: NOW,
  });
  const feature = () => ({
    kind: "feature",
    run: "r1",
    feature: "F-1",
    tasks: [{ task: "T-7", discipline: "backend", rounds: 2, spend }],
    by_discipline: [{ discipline: "backend", spend }],
    traceability: { ...report(), task: undefined, feature: "F-1" },
    findings: counts,
    deferred: [SHA],
    final_review: { verdict: "pass", rounds: 1 },
    spend: { ...spend, usd: null },
    written_at: NOW,
  });
  it("accepts a task and a feature bundle", () => {
    expectValid(EvidenceBundleSchema, task());
    expectValid(EvidenceBundleSchema, feature());
  });
  it.each([
    [() => ({ ...task(), cap: 7 }), "cap"],
    [() => ({ ...task(), kind: "pr" }), "kind"],
    [
      () => ({
        ...task(),
        verdicts: [{ role: "qa", subject: "x", verdict: "pass", prompt_sha: SHA }],
      }),
      "verdicts.0.subject",
    ],
    [() => ({ ...feature(), tasks: [] }), "tasks"],
    [() => ({ ...feature(), final_review: { verdict: "pass", rounds: 4 } }), "final_review.rounds"],
  ] as const)("case %#: rejects an invalid bundle", (make, path) => {
    expectInvalid(EvidenceBundleSchema, make(), path);
  });
  it("lives at .vtc/evidence/<id>/bundle.json", () => {
    expect(evidenceBundlePath("T-7")).toBe(".vtc/evidence/T-7/bundle.json");
    expect(evidenceBundlePath("F-1")).toBe(".vtc/evidence/F-1/bundle.json");
    expect(() => evidenceBundlePath("../x")).toThrow();
  });
});

describe("TaskPackSchema and renderTaskPack (§6.3 step 1)", () => {
  const pack = () => ({
    v: 1,
    run: "r1",
    action_id: "a-4",
    role: "engineer",
    task: "T-7",
    intent: validTaskDraft().intent,
    requirements: [{ id: "REQ-3.AC-2", text: "Given an expired token When reset Then 410" }],
    decisions: [{ id: "AD-4", text: "Tokens are stored hashed" }],
    inputs: [
      { type: "repo_map_slice", path: ".vtc/state/packs/a-4/repo-map.md" },
      { type: "interface_contract", path: "contracts/auth.yaml", sha256: SHA },
    ],
    files_scope: ["src/auth/reset/**"],
    gates: [{ id: "tests", layer: "L2", command: ["pnpm", "test"] }],
    findings: [validFinding()],
  });
  it("validates a pack and renders every section in order", () => {
    expectValid(TaskPackSchema, pack());
    const text = renderTaskPack(pack() as never);
    const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings).toEqual([...TASK_PACK_SECTIONS]);
    expect(text).toContain("REQ-3.AC-2: Given an expired token");
    expect(text).toContain("interface_contract: contracts/auth.yaml");
    expect(text).toContain("## Human answer\n\n(none)");
    expect(renderTaskPack(pack() as never)).toBe(text);
  });
  it.each([
    ["decisions.0.id", { decisions: [{ id: "ADR-1", text: "x" }] }],
    ["inputs.0.path", { inputs: [{ type: "spec", path: "/spec.md" }] }],
    ["subject", { subject: "AC-1" }],
    ["gates.0.command", { gates: [{ id: "t", layer: "L2", command: [] }] }],
    ["", { secrets: ["x"] }],
  ])("rejects invalid %s", (path, patch) => {
    expectInvalid(TaskPackSchema, { ...pack(), ...patch }, path);
  });
  it("one pack per dispatch under .vtc/state/packs/", () => {
    expect(taskPackPath("a-4")).toBe(".vtc/state/packs/a-4.md");
    expect(() => taskPackPath("../x")).toThrow();
  });
});
