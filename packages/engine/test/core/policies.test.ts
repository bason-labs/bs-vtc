/**
 * Unit tests for every state transition, cap, budget rule, router rule and triage route
 * (AD-8 rule 1, AD-11 rule 2), plus seeded property tests for the scheduler and DAG invariants.
 */
import { describe, expect, it } from "vitest";
import {
  TaskStatusSchema,
  type Finding,
  type GateResult,
  type Task,
  type TaskDraft,
  type TaskStatus,
} from "@vtc/shared";
import {
  assertFeatureTransition,
  assertTaskTransition,
  canTransitionTask,
  InvalidTransitionError,
  TASK_TRANSITIONS,
} from "../../src/core/machines.js";
import { dependenciesMet, schedule, transitiveDependents } from "../../src/core/scheduler.js";
import { checkPlan, findDependencyCycle } from "../../src/core/plan-check.js";
import {
  decideAfterFailedRound,
  engineerDispatch,
  findingRiskRule,
  stuckReason,
} from "../../src/core/loop.js";
import {
  findingFromDraft,
  findingFromGateFailure,
  findingFromTool,
  findingFromVerdict,
  findingsFromWriteScope,
  mergeRound,
} from "../../src/core/triage.js";
import { budgetState, raisedBudget, taskBudgetFor } from "../../src/core/budget.js";
import { diffRiskHits, isTrivialDiff, reviewersFor } from "../../src/core/router.js";
import { globMatch, globsOverlap } from "../../src/core/globs.js";
import { acceptanceCriteriaOf, parseSpecItems } from "../../src/core/spec.js";
import { ProjectConfigSchema } from "@vtc/shared";

// ------------------------------------------------------------------ helpers

/** Deterministic PRNG (mulberry32) for property tests without a dependency. */
const rng = (seed: number) => {
  let a = seed;
  return (): number => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const task = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  title: `Task ${id}`,
  feature: "F-1",
  origin: "planner",
  covers: ["REQ-1"],
  after: [],
  files_scope: [`src/${id.toLowerCase()}/**`],
  discipline: "backend",
  stack_packs: [],
  consumes_contracts: [],
  risk: "med",
  risk_tags: [],
  cap: 4,
  size: "M",
  arch_triage: "fits",
  budget_usd: 5,
  spent_usd: 0,
  status: "draft",
  round: 0,
  deferred: [],
  ...over,
});

const draft = (id: string, over: Partial<TaskDraft> = {}): TaskDraft => ({
  id,
  title: `Task ${id}`,
  covers: ["REQ-1"],
  after: [],
  files_scope: [`src/${id.toLowerCase()}/**`],
  discipline: "backend",
  stack_packs: [],
  consumes_contracts: [],
  risk: "med",
  risk_tags: [],
  size: "M",
  arch_triage: "fits",
  intent: {
    statement: "x",
    always: [],
    never: [],
    io_matrix: [{ case: "a", input: "b", expected: "c" }],
  },
  ...over,
});

const finding = (over: Partial<Finding> = {}): Finding => ({
  fingerprint: "a".repeat(64),
  source: "role",
  source_name: "spec_verifier",
  rule_id: "r",
  category: "correctness",
  kind: "implementation_deviation",
  title: "bug",
  severity: "medium",
  confidence: 1,
  location: { path: "src/a.ts" },
  evidence: { type: "file", ref: "src/a.ts" },
  req_ids: [],
  route: "patch",
  task: "T-1",
  round_first_seen: 1,
  status: "open",
  ...over,
});

// ------------------------------------------------------------- state machines

describe("task state machine (§6.4)", () => {
  it("allows the main path in order", () => {
    const path: TaskStatus[] = [
      "draft",
      "ready",
      "tests_authored",
      "building",
      "verifying",
      "fixing",
      "verifying",
      "built",
      "queued",
      "merged",
      "done",
    ];
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransitionTask(path[i - 1]!, path[i]!)).toBe(true);
    }
  });
  it("lets no state reach done except merged, and done is terminal", () => {
    for (const from of TaskStatusSchema.options) {
      expect(canTransitionTask(from, "done")).toBe(from === "merged");
    }
    expect(TASK_TRANSITIONS.done).toEqual([]);
    expect(TASK_TRANSITIONS.dropped).toEqual([]);
  });
  it("never sets non_converged (reserved, spine §5 reading 9)", () => {
    for (const from of TaskStatusSchema.options)
      expect(canTransitionTask(from, "non_converged")).toBe(false);
  });
  it("parks from any working state and resumes to a checkpoint", () => {
    for (const from of [
      "ready",
      "tests_authored",
      "building",
      "verifying",
      "fixing",
      "built",
      "queued",
    ] as const) {
      expect(canTransitionTask(from, "parked")).toBe(true);
      expect(canTransitionTask("parked", from)).toBe(true);
    }
    expect(canTransitionTask("parked", "done")).toBe(false);
    expect(canTransitionTask("parked", "merged")).toBe(false);
  });
  it("interrupts only steps that run a role, and resumes them", () => {
    for (const from of ["ready", "tests_authored", "building", "verifying", "fixing"] as const) {
      expect(canTransitionTask(from, "interrupted")).toBe(true);
      expect(canTransitionTask("interrupted", from)).toBe(true);
    }
    expect(canTransitionTask("queued", "interrupted")).toBe(false);
  });
  it("throws a typed error on an invalid transition", () => {
    expect(() => {
      assertTaskTransition("T-1", "draft", "built");
    }).toThrow(InvalidTransitionError);
    expect(() => {
      assertTaskTransition("T-1", "queued", "fixing");
    }).not.toThrow();
  });
  it("feature: building → integrating → final_review ⇄ fixing → ready_to_ship → shipped", () => {
    expect(() => {
      assertFeatureTransition("F-1", "building", "integrating");
    }).not.toThrow();
    expect(() => {
      assertFeatureTransition("F-1", "final_review", "fixing");
    }).not.toThrow();
    expect(() => {
      assertFeatureTransition("F-1", "fixing", "final_review");
    }).not.toThrow();
    expect(() => {
      assertFeatureTransition("F-1", "ready_to_ship", "shipped");
    }).not.toThrow();
    expect(() => {
      assertFeatureTransition("F-1", "building", "shipped");
    }).toThrow(InvalidTransitionError);
    expect(() => {
      assertFeatureTransition("F-1", "shipped", "building");
    }).toThrow(InvalidTransitionError);
  });
});

// ------------------------------------------------------------------ scheduler

const view = (tasks: Task[], frozen: string[] = []) => ({
  tasks: new Map(tasks.map((t) => [t.id, t])),
  frozenContracts: new Set(frozen),
});

const input = (tasks: Task[], over: Partial<Parameters<typeof schedule>[0]> = {}) => ({
  ...view(tasks),
  order: tasks.map((t) => t.id),
  scopes: new Map(tasks.map((t) => [t.id, t.files_scope])),
  concurrency: 2,
  busySlots: 0,
  remainingPct: null,
  reservePct: 10,
  paused: false,
  ...over,
});

describe("scheduler (§6.6, AD-8 rule 12)", () => {
  it("releases after-dependencies only when merged or done", () => {
    const t2 = task("T-2", { after: ["T-1"] });
    for (const [status, ok] of [
      ["built", false],
      ["queued", false],
      ["merged", true],
      ["done", true],
      ["parked", false],
    ] as const) {
      expect(dependenciesMet(t2, view([task("T-1", { status }), t2]))).toBe(ok);
    }
  });
  it("releases a contract consumer on contract.frozen, before the provider merges", () => {
    const consumer = task("T-2", {
      consumes_contracts: [{ provider: "T-1", kind: "openapi", path: "api/openapi.yaml" }],
    });
    const provider = task("T-1", { status: "building" });
    expect(dependenciesMet(consumer, view([provider, consumer]))).toBe(false);
    expect(dependenciesMet(consumer, view([provider, consumer], ["T-1"]))).toBe(true);
  });
  it("starts at most `concurrency` tasks and marks blocked ones waiting", () => {
    const tasks = [task("T-1"), task("T-2"), task("T-3"), task("T-4", { after: ["T-1"] })];
    const decision = schedule(input(tasks));
    expect(decision.start).toEqual(["T-1", "T-2"]);
    expect(decision.waiting).toEqual(["T-4"]);
    expect(schedule(input(tasks, { busySlots: 1 })).start).toEqual(["T-1"]);
    expect(schedule(input(tasks, { busySlots: 2 })).held).toBe("no_slot");
  });
  it("refuses two tasks with overlapping files_scope at once", () => {
    const a = task("T-1", { files_scope: ["src/**"] });
    const b = task("T-2", { files_scope: ["src/api/**"] });
    const c = task("T-3", { files_scope: ["web/**"] });
    expect(schedule(input([a, b, c])).start).toEqual(["T-1", "T-3"]);
    const running = task("T-1", { files_scope: ["src/**"], status: "building" });
    expect(schedule(input([running, b, c])).start).toEqual(["T-3"]);
  });
  it("holds new work below the usage reserve and while paused; unknown usage does not hold", () => {
    const tasks = [task("T-1")];
    expect(schedule(input(tasks, { remainingPct: 5 })).held).toBe("usage_reserve");
    expect(schedule(input(tasks, { remainingPct: 5 })).start).toEqual([]);
    expect(schedule(input(tasks, { remainingPct: 50 })).start).toEqual(["T-1"]);
    expect(schedule(input(tasks, { remainingPct: null })).start).toEqual(["T-1"]);
    expect(schedule(input(tasks, { paused: true })).held).toBe("paused");
  });
  it("a parked task blocks only its transitive dependents", () => {
    const tasks = [
      task("T-1", { status: "parked", park_reason: "cap" }),
      task("T-2", { after: ["T-1"] }),
      task("T-3", { after: ["T-2"] }),
      task("T-4"),
    ];
    expect(transitiveDependents("T-1", tasks)).toEqual(["T-2", "T-3"]);
    expect(schedule(input(tasks)).start).toEqual(["T-4"]);
  });

  it("property: never exceeds concurrency, never starts overlapping or unreleased tasks", () => {
    const statuses: TaskStatus[] = [
      "draft",
      "draft",
      "draft",
      "waiting_dependency",
      "building",
      "merged",
      "done",
      "parked",
      "verifying",
    ];
    for (let seed = 1; seed <= 300; seed += 1) {
      const r = rng(seed);
      const n = 2 + Math.floor(r() * 8);
      const tasks: Task[] = [];
      for (let i = 1; i <= n; i += 1) {
        const after = tasks.filter(() => r() < 0.25).map((t) => t.id);
        const status = statuses[Math.floor(r() * statuses.length)] ?? "draft";
        tasks.push(
          task(`T-${String(i)}`, {
            after,
            status,
            ...(status === "parked" ? { park_reason: "cap" as const } : {}),
            files_scope: [`src/m${String(Math.floor(r() * 5))}/**`],
          }),
        );
      }
      const concurrency = 1 + Math.floor(r() * 3);
      const busy = Math.floor(r() * 3);
      const decision = schedule(input(tasks, { concurrency, busySlots: busy }));
      expect(decision.start.length).toBeLessThanOrEqual(Math.max(0, concurrency - busy));
      const byId = new Map(tasks.map((t) => [t.id, t]));
      const active = tasks.filter((t) =>
        [
          "ready",
          "tests_authored",
          "building",
          "verifying",
          "fixing",
          "interrupted",
          "built",
          "queued",
        ].includes(t.status),
      );
      for (const id of decision.start) {
        const t = byId.get(id)!;
        expect(["draft", "waiting_dependency"]).toContain(t.status);
        expect(dependenciesMet(t, view(tasks))).toBe(true);
        for (const other of [
          ...active.map((a) => a.id),
          ...decision.start.filter((s) => s !== id),
        ]) {
          expect(globsOverlap(t.files_scope[0]!, byId.get(other)!.files_scope[0]!)).toBe(false);
        }
      }
      for (const id of decision.waiting)
        expect(dependenciesMet(byId.get(id)!, view(tasks))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------- plan checks

describe("PLAN checks (§6.1)", () => {
  it("accepts a covered acyclic plan with disjoint parallel scopes", () => {
    expect(
      checkPlan({
        drafts: [draft("T-1"), draft("T-2", { after: ["T-1"], covers: ["REQ-2"] })],
        requirements: ["REQ-1", "REQ-2"],
      }),
    ).toEqual([]);
  });
  it("rejects uncovered REQs, unknown references and cycles", () => {
    expect(checkPlan({ drafts: [draft("T-1")], requirements: ["REQ-1", "REQ-2"] })).toContain(
      "REQ-2 is not covered by any task",
    );
    expect(checkPlan({ drafts: [draft("T-1", { after: ["T-9"] })], requirements: [] })).toContain(
      "T-1 depends on unknown task T-9",
    );
    const cyclic = [draft("T-1", { after: ["T-2"] }), draft("T-2", { after: ["T-1"] })];
    expect(findDependencyCycle(cyclic)).not.toBeNull();
    expect(
      checkPlan({ drafts: cyclic, requirements: [] }).some((i) => i.startsWith("dependency cycle")),
    ).toBe(true);
  });
  it("rejects overlapping scopes only for tasks that can run in parallel", () => {
    const a = draft("T-1", { files_scope: ["src/**"] });
    const b = draft("T-2", { files_scope: ["src/x/**"] });
    expect(checkPlan({ drafts: [a, b], requirements: [] })).toContain(
      "T-1 and T-2 can run in parallel but their files_scope overlap",
    );
    expect(checkPlan({ drafts: [a, { ...b, after: ["T-1"] }], requirements: [] })).toEqual([]);
  });
  it("checks that a consumed contract is the one its provider publishes", () => {
    const provider = draft("T-1", { provides_contract: { kind: "openapi", path: "api.yaml" } });
    const ok = draft("T-2", {
      files_scope: ["web/**"],
      consumes_contracts: [{ provider: "T-1", kind: "openapi", path: "api.yaml" }],
    });
    expect(checkPlan({ drafts: [provider, ok], requirements: [] })).toEqual([]);
    const wrong = {
      ...ok,
      consumes_contracts: [{ provider: "T-1", kind: "openapi" as const, path: "other.yaml" }],
    };
    expect(checkPlan({ drafts: [provider, wrong], requirements: [] })[0]).toContain(
      "does not provide",
    );
  });
  it("property: random DAGs built forward never report a cycle", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = rng(seed);
      const drafts: TaskDraft[] = [];
      for (let i = 1; i <= 2 + Math.floor(r() * 10); i += 1) {
        drafts.push(
          draft(`T-${String(i)}`, { after: drafts.filter(() => r() < 0.3).map((d) => d.id) }),
        );
      }
      expect(findDependencyCycle(drafts)).toBeNull();
      const last = drafts.at(-1)!;
      if (last.id !== "T-1") {
        const looped = drafts.map((d) => (d.id === "T-1" ? { ...d, after: [last.id] } : d));
        const reachesT1 = (id: string, seen = new Set<string>()): boolean => {
          if (id === "T-1") return true;
          if (seen.has(id)) return false;
          seen.add(id);
          return (looped.find((d) => d.id === id)?.after ?? []).some((x) => reachesT1(x, seen));
        };
        expect(findDependencyCycle(looped) !== null).toBe(reachesT1(last.id));
      }
    }
  });
});

// ------------------------------------------------------------- loop controller

describe("loop controller (§6.3 step 9)", () => {
  const signals = (over: Partial<Parameters<typeof decideAfterFailedRound>[0]> = {}) => ({
    round: 1,
    cap: 4,
    findings: [finding()],
    reappeared: false,
    identicalTree: false,
    ...over,
  });
  it("starts the next fix round under the cap", () => {
    expect(decideAfterFailedRound(signals())).toEqual({ kind: "fix", round: 2 });
  });
  it.each([
    ["low", 3],
    ["med", 4],
    ["high", 5],
  ] as const)("parks with cap when risk %s reaches cap %i", (_risk, cap) => {
    const many = Array.from({ length: cap }, (_v, i) =>
      finding({
        fingerprint: String(i).padStart(64, "0"),
        round_first_seen: i + 1,
        severity: i % 2 === 0 ? "high" : "low",
        status: i === cap - 1 ? "open" : "resolved",
      }),
    );
    const decision = decideAfterFailedRound(signals({ round: cap, cap, findings: many }));
    expect(decision.kind).toBe("park");
    if (decision.kind === "park") expect(["cap", "stuck"]).toContain(decision.reason);
    expect(
      decideAfterFailedRound(
        signals({ round: cap, cap, findings: [finding({ round_first_seen: cap })] }),
      ),
    ).toMatchObject({ kind: "park", reason: "cap" });
  });
  it("is stuck when a fingerprint survives 2 rounds", () => {
    expect(
      stuckReason(
        signals({ round: 3, findings: [finding({ round_first_seen: 1, round_last_seen: 3 })] }),
      ),
    ).toMatch(/survived 2 rounds/);
    expect(
      stuckReason(
        signals({
          round: 2,
          findings: [
            finding({ round_first_seen: 1, round_last_seen: 2, severity: "high" }),
            finding({
              fingerprint: "b".repeat(64),
              round_first_seen: 1,
              round_last_seen: 1,
              status: "resolved",
              severity: "critical",
            }),
          ],
        }),
      ),
    ).toBeNull();
  });
  it("is stuck when a resolved finding reappears or the diff is identical", () => {
    expect(decideAfterFailedRound(signals({ reappeared: true }))).toMatchObject({
      kind: "park",
      reason: "stuck",
    });
    expect(decideAfterFailedRound(signals({ identicalTree: true }))).toMatchObject({
      kind: "park",
      reason: "stuck",
    });
  });
  it("is stuck when weighted severity does not drop", () => {
    const r1 = finding({ fingerprint: "1".repeat(64), round_first_seen: 1, status: "resolved" });
    const r2 = finding({ fingerprint: "2".repeat(64), round_first_seen: 2 });
    expect(stuckReason(signals({ round: 2, findings: [r1, r2] }))).toMatch(/did not drop/);
    const lighter = finding({ fingerprint: "3".repeat(64), round_first_seen: 2, severity: "low" });
    expect(stuckReason(signals({ round: 2, findings: [r1, lighter] }))).toBeNull();
  });
  it("escalates the Engineer one tier, in a fresh session, after 2 failed rounds", () => {
    expect(engineerDispatch("mid", 1)).toEqual({
      tier: "mid",
      freshSession: false,
      escalated: false,
    });
    expect(engineerDispatch("mid", 2)).toEqual({
      tier: "mid",
      freshSession: false,
      escalated: false,
    });
    expect(engineerDispatch("mid", 3)).toEqual({
      tier: "top",
      freshSession: true,
      escalated: true,
    });
    expect(engineerDispatch("mid", 4)).toEqual({
      tier: "top",
      freshSession: false,
      escalated: true,
    });
    expect(engineerDispatch("top", 3)).toEqual({
      tier: "top",
      freshSession: true,
      escalated: true,
    });
  });
  it("rule 9: a high finding still open after one fix round; rule 8: repeated test integrity", () => {
    const high = finding({ category: "security", severity: "high", round_first_seen: 1 });
    expect(findingRiskRule([high], 1)).toBeNull();
    expect(findingRiskRule([high], 2)).toMatchObject({ rule: "open_high_finding" });
    const correctness = finding({ severity: "medium", round_first_seen: 1, round_last_seen: 3 });
    expect(findingRiskRule([correctness], 4)).toBeNull();
    const integrity = finding({
      category: "test_integrity",
      severity: "high",
      round_first_seen: 1,
      round_last_seen: 2,
      source: "tool",
      source_name: "write_scope",
    });
    expect(findingRiskRule([integrity], 2)).toMatchObject({ rule: "repeated_test_integrity" });
  });
});

// ---------------------------------------------------------------------- triage

describe("triage (§6.3 step 8, AD-8 rules 6–7)", () => {
  const ctx = { task: "T-1", round: 2 };
  const base = {
    rule_id: "x",
    title: "t",
    confidence: 0.5,
    location: { path: "src/a.ts", symbol: "f" },
    evidence: { type: "file_line" as const, ref: "src/a.ts:3" },
    req_ids: [],
  };
  it.each([
    ["secret", "implementation_deviation", "risky", "critical"],
    ["test_adequacy", "implementation_deviation", "bad_test", "medium"],
    ["docs", "implementation_deviation", "defer", "info"],
    ["correctness", "implementation_deviation", "patch", "medium"],
    ["design", "design_ambiguity", "design_gap", "low"],
    ["correctness", "observed_mismatch", "spec_gap", "medium"],
    ["correctness", "spec_ambiguity", "spec_gap", "medium"],
    ["correctness", "test_defect", "bad_test", "medium"],
    ["security", "implementation_deviation", "patch", "high"],
  ] as const)(
    "role %s/%s → %s at %s, ignoring the claimed severity",
    (category, kind, route, severity) => {
      const f = findingFromDraft(
        { ...base, category, kind, claimed_severity: "critical" },
        "security",
        ctx,
      );
      expect([f.route, f.severity, f.round_first_seen, f.status, f.task]).toEqual([
        route,
        severity,
        2,
        "open",
        "T-1",
      ]);
      expect(f.claimed_severity).toBe("critical");
    },
  );
  it("tool findings route patch with a severity from score, label or SARIF level", () => {
    const tool = {
      tool: "opengrep",
      rule_id: "r",
      category: "security" as const,
      title: "t",
      location: { path: "a.ts" },
      evidence: { type: "sarif" as const, ref: "r.sarif#0" },
    };
    expect(findingFromTool({ ...tool, score: 9.1 }, ctx)).toMatchObject({
      route: "patch",
      severity: "critical",
      source: "tool",
    });
    expect(findingFromTool({ ...tool, label: "moderate" }, ctx).severity).toBe("medium");
    expect(findingFromTool({ ...tool, sarif_level: "note" }, ctx).severity).toBe("low");
    expect(findingFromTool({ ...tool, category: "secret" }, ctx).route).toBe("risky");
  });
  it("fingerprints ignore line shifts and the reporting source, so duplicates merge", () => {
    const a = findingFromDraft(
      { ...base, category: "correctness", kind: "implementation_deviation" },
      "qa",
      ctx,
    );
    const b = findingFromDraft(
      {
        ...base,
        category: "correctness",
        kind: "implementation_deviation",
        location: { path: "src/a.ts", symbol: "f", line: 99 },
      },
      "security",
      ctx,
    );
    expect(a.fingerprint).toBe(b.fingerprint);
  });
  it("a failed gate without parsed findings becomes one finding; verdicts too", () => {
    const gate: GateResult = {
      gate_id: "tests",
      layer: "L2",
      phase: "verify",
      status: "fail",
      blocking: true,
      new_violations: 0,
      baseline_violations: 0,
      monotonic: [],
      findings: [],
      failure_class: "product",
      evidence: [],
      duration_ms: 1,
    };
    expect(findingFromGateFailure(gate, ctx)).toMatchObject({
      route: "patch",
      rule_id: "gate.tests",
      source: "tool",
    });
    const v = findingFromVerdict(
      {
        subject: "REQ-1.AC-1",
        verdict: "unchecked",
        evidence: [{ type: "spec_ref", ref: "REQ-1.AC-1" }],
      },
      "spec_verifier",
      { ...ctx, fallbackPath: ".vtc/tasks/T-1.md" },
    );
    expect(v).toMatchObject({
      route: "patch",
      req_ids: ["REQ-1.AC-1"],
      location: { path: ".vtc/tasks/T-1.md" },
    });
  });
  it("write-scope violations are high test-integrity findings", () => {
    const [f] = findingsFromWriteScope(
      { ok: false, violations: [{ kind: "out_of_scope_write", path: "lib/x.ts" }] },
      ctx,
    );
    expect(f).toMatchObject({ category: "test_integrity", severity: "high", route: "patch" });
  });
  it("merges rounds: repeats extend round_last_seen, silence resolves, a resolved one reappearing is flagged", () => {
    const old = finding({ round_first_seen: 1 });
    const merged = mergeRound(
      [old],
      [finding({ round_first_seen: 2 })],
      new Set(["spec_verifier"]),
      2,
    );
    expect(merged.recorded[0]).toMatchObject({
      round_first_seen: 1,
      round_last_seen: 2,
      status: "open",
    });
    expect(merged.reappeared).toBe(false);
    const silent = mergeRound([old], [], new Set(["spec_verifier"]), 2);
    expect(silent.resolved.map((f) => f.fingerprint)).toEqual([old.fingerprint]);
    expect(mergeRound([old], [], new Set(["opengrep"]), 2).resolved).toEqual([]);
    const back = mergeRound(
      [{ ...old, status: "resolved" }],
      [finding({ round_first_seen: 3 })],
      new Set(),
      3,
    );
    expect(back.reappeared).toBe(true);
  });
});

// ---------------------------------------------------------------------- budget

describe("budget controller (§11)", () => {
  const config = ProjectConfigSchema.parse({ version: 1 });
  it("sizes budgets from project.yaml", () => {
    expect([
      taskBudgetFor("S", config),
      taskBudgetFor("M", config),
      taskBudgetFor("L", config),
    ]).toEqual([1.5, 5, 15]);
  });
  it("drops reviewers a tier at 70% and is exhausted at 100%", () => {
    expect(budgetState(3.4, 5)).toBe("ok");
    expect(budgetState(3.5, 5)).toBe("reviewers_drop");
    expect(budgetState(5, 5)).toBe("exhausted");
  });
  it("raises only by a human factor in (1, 2], never above 2× the original", () => {
    expect(raisedBudget(5, 5, 1.5)).toBe(7.5);
    expect(raisedBudget(5, 7.5, 2)).toBe(10);
    expect(() => raisedBudget(5, 5, 2.5)).toThrow();
    expect(() => raisedBudget(5, 5, 1)).toThrow();
  });
});

// ------------------------------------------------------------------ risk router

describe("risk router (§6.3 steps 6–7, §7.6)", () => {
  const run = { has_ui: false, risk_hints: [] };
  it("attaches one Spec-Verifier per AC, more reviewers with risk", () => {
    expect(reviewersFor(task("T-2"), run, ["REQ-2.AC-1"]).map((r) => r.id)).toEqual([
      "spec-verifier",
    ]);
    const two = reviewersFor(task("T-2"), run, ["REQ-1.AC-1", "REQ-1.AC-2"]);
    expect(two.map((r) => [r.id, r.subject])).toEqual([
      ["spec-verifier-req-1-ac-1", "REQ-1.AC-1"],
      ["spec-verifier-req-1-ac-2", "REQ-1.AC-2"],
    ]);
    expect(reviewersFor(task("T-1", { risk: "high" }), run, []).map((r) => r.role)).toEqual([
      "spec_verifier",
      "qa",
      "security",
    ]);
    expect(reviewersFor(task("T-1", { risk_tags: ["auth"] }), run, []).map((r) => r.role)).toEqual([
      "spec_verifier",
      "security",
    ]);
    // Visual QA attaches only once the round's visual step rendered (option `visual`, reading 149)
    expect(
      reviewersFor(
        task("T-1", { discipline: "frontend" }),
        { has_ui: true, risk_hints: [] },
        [],
      ).filter((r) => r.role === "visual_qa"),
    ).toHaveLength(0);
  });
  it("adds a lens reviewer node per risk tag whose lens role is installed (§5.3; reading 92)", () => {
    const lensRoles = ["lens_auth", "lens_db", "lens_payments", "lens_supply_chain"];
    const slots = reviewersFor(
      task("T-1", { risk_tags: ["auth", "migration", "payments", "billing", "new-dependency"] }),
      run,
      [],
      { lensRoles },
    );
    expect(slots.filter((s) => s.role.startsWith("lens_")).map((s) => [s.id, s.subject])).toEqual([
      ["lens-auth", "T-1"],
      ["lens-db", "T-1"],
      ["lens-payments", "T-1"],
      ["lens-supply-chain", "T-1"],
    ]);
    // a lens role the compiled set does not have is never attached
    expect(
      reviewersFor(task("T-1", { risk_tags: ["infra"] }), run, [], { lensRoles }).map(
        (s) => s.role,
      ),
    ).toEqual(["spec_verifier"]);
    // no lens roles passed: none attached
    expect(reviewersFor(task("T-1", { risk_tags: ["auth"] }), run, []).map((s) => s.role)).toEqual([
      "spec_verifier",
      "security",
    ]);
  });
  it("skips reviewers on documentation-only diffs", () => {
    expect(isTrivialDiff([{ path: "README.md", status: "modified" }])).toBe(true);
    expect(isTrivialDiff([{ path: "src/a.ts", status: "modified" }])).toBe(false);
    expect(isTrivialDiff([])).toBe(false);
  });
  it.each([
    ["src/auth/login.ts", "sensitive_area"],
    ["db/migrations/001.sql", "db_migration"],
    [".github/workflows/ci.yml", "protected_config"],
    ["Dockerfile", "protected_config"],
    [".vtc/project.yaml", "protected_config"],
    ["src/eslint.config.js", "protected_config"],
  ])("%s fires %s", (path, rule) => {
    const hits = diffRiskHits({
      files: [{ path, status: "modified" }],
      changedLines: 3,
      riskRules: { paths: [], max_diff_lines: 800, max_diff_files: 30 },
      newDependencies: [],
    });
    expect(hits.map((h) => h.rule)).toContain(rule);
  });
  it("fires large_diff, new_dependency and configured risk paths", () => {
    const rules = { paths: ["src/billing-v2/**"], max_diff_lines: 800, max_diff_files: 30 };
    expect(
      diffRiskHits({
        files: [{ path: "src/a.ts", status: "added" }],
        changedLines: 801,
        riskRules: rules,
        newDependencies: [],
      }).map((h) => h.rule),
    ).toEqual(["large_diff"]);
    expect(
      diffRiskHits({
        files: [{ path: "src/a.ts", status: "added" }],
        changedLines: 1,
        riskRules: rules,
        newDependencies: ["left-pad"],
      }).map((h) => h.rule),
    ).toEqual(["new_dependency"]);
    expect(
      diffRiskHits({
        files: [{ path: "src/billing-v2/x.ts", status: "added" }],
        changedLines: 1,
        riskRules: rules,
        newDependencies: [],
      }).map((h) => h.rule),
    ).toEqual(["sensitive_area"]);
    expect(
      diffRiskHits({
        files: [{ path: "src/a.ts", status: "added" }],
        changedLines: 1,
        riskRules: rules,
        newDependencies: [],
      }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------- globs, spec

describe("globs and the spec reader", () => {
  it("matches ** across segments and * within one", () => {
    expect(globMatch("src/**", "src/a/b.ts")).toBe(true);
    expect(globMatch("src/*.ts", "src/a/b.ts")).toBe(false);
    expect(globMatch("**/Dockerfile", "Dockerfile")).toBe(true);
    expect(globMatch("**/Dockerfile", "a/b/Dockerfile")).toBe(true);
    expect(globMatch("src/{a,b}/**", "src/b/x")).toBe(true);
    expect(globsOverlap("src/**", "src/a/**")).toBe(true);
    expect(globsOverlap("src/a/**", "src/b/**")).toBe(false);
    expect(globsOverlap("src/a.ts", "src/*.ts")).toBe(true);
  });
  it("reads REQs and ACs from the frozen spec", () => {
    const items = parseSpecItems(
      "# Spec\n\n## REQ-1 Store\n\nThe system shall store.\n\n- REQ-1.AC-1: Given a When b Then c.\n- REQ-1.AC-2: More.\n\n## REQ-2 Endpoint\n\n- REQ-2.AC-1: x\n",
    );
    expect(items.map((i) => i.id)).toEqual([
      "REQ-1",
      "REQ-1.AC-1",
      "REQ-1.AC-2",
      "REQ-2",
      "REQ-2.AC-1",
    ]);
    expect(items[0]?.text).toBe("Store");
    expect(acceptanceCriteriaOf(items, ["REQ-1"])).toEqual(["REQ-1.AC-1", "REQ-1.AC-2"]);
  });
});
