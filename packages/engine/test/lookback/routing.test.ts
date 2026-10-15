/**
 * Lookback tunes routing (D-cn; spine §5 reading 219): the routing scorecard from the
 * `role.dispatched` tier records (`RoutingScorecard`), the routing-table proposals it backs and the
 * `config` facts engine core hands the upstream module.
 */
import {
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  RoutingScorecardSchema,
  RoutingTableSchema,
  routingConfigSubject,
  type ModelTier,
  type RoutingScorecard,
  type RoutingTable,
} from "@vtc/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  computeRoutingScorecard,
  routedStartTier,
  routingProposals,
  routingReplayTasks,
  traceSplit,
  writeRoutingScorecard,
  type RoutingCell,
} from "../../src/lookback/index.js";
import { HOST, RunLog, tempDir } from "./log.js";

/**
 * D-cm's routing table as decided (spine §5 reading 218(2)): the proposal tests measure against
 * it, since `DEFAULT_ROUTING_TABLE`'s tiers move through reviewed D-cn routing PRs that change
 * `tier-routing.ts` only (reading 233).
 */
const DCM: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

const BUNDLE = "9".repeat(64);
const now = new Date("2026-10-15T09:00:00.000Z");

/** A task of `size` (default S, no risk tag) and its Engineer dispatches. */
const routedTask = (
  log: RunLog,
  task: string,
  options: {
    size?: "S" | "M" | "L";
    risk?: "low" | "med" | "high";
    riskTags?: string[];
    tier?: ModelTier;
    reason?: "rule" | "planner_hint" | "role" | "escalation" | "budget_drop";
    clamped?: boolean;
    pass?: boolean;
    escalate?: boolean;
    role?: string;
    mode?: string;
    cost?: number | null;
    action?: string;
  } = {},
): void => {
  log.taskCreated(task, "backend", [], {
    size: options.size ?? "S",
    risk: options.risk ?? "low",
    riskTags: options.riskTags ?? [],
  });
  const role = options.role ?? "engineer";
  log.dispatch(role, {
    task,
    tier: options.tier ?? "low",
    tierReason: options.reason ?? "rule",
    ...(options.clamped === undefined ? {} : { tierClamped: options.clamped }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    ...(options.action === undefined ? {} : { action: options.action }),
  });
  log.gate(task, options.pass ?? true);
  if (options.escalate === true) {
    log.dispatch(role, {
      task,
      tier: "mid",
      tierReason: "escalation",
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    log.gate(task, true);
  }
};

const scorecardOf = (log: RunLog): RoutingScorecard =>
  computeRoutingScorecard({ history: log.events, graderBundleSha: BUNDLE, now });

describe("the routing scorecard (D-cn)", () => {
  it("scores each task's first dispatch cell from its tier record, with the scorecard metrics", () => {
    const log = new RunLog();
    for (let i = 1; i <= 12; i += 1) routedTask(log, `T-${String(i)}`, { cost: 0.2 });
    const card = scorecardOf(log);
    expect(RoutingScorecardSchema.safeParse(card).success).toBe(true);
    expect(card.grader_bundle_sha).toBe(BUNDLE);
    expect(card.cells).toHaveLength(1);
    const [cell] = card.cells;
    expect(cell).toMatchObject({
      role: "engineer",
      host: HOST,
      size: "S",
      risk: "none",
      start_tier: "low",
      start_reason: "rule",
      tasks: 12,
      escalated: { value: 0, n: 12 },
      cost_per_task_usd: { value: 0.2, n: 12 },
    });
    expect(cell?.metrics.first_round_gate_pass).toMatchObject({ value: 1, n: 12 });
    expect(cell?.metrics.tokens_per_success).toMatchObject({ value: 1000, n: 12 });
  });

  it("counts a task whose role escalated a tier, and its later rounds, in the cell it started in", () => {
    const log = new RunLog();
    for (let i = 1; i <= 12; i += 1)
      routedTask(log, `T-${String(i)}`, { pass: i > 6, escalate: i <= 6 });
    const card = scorecardOf(log);
    expect(card.cells.map((c) => [c.start_tier, c.start_reason, c.tasks])).toEqual([
      ["low", "rule", 12],
    ]);
    const [cell] = card.cells;
    expect(cell?.escalated.value).toBe(0.5);
    expect(cell?.escalated.ci_low).toBeGreaterThan(0);
    expect(cell?.escalated.ci_high).toBeLessThan(1);
    expect(cell?.metrics.first_round_gate_pass?.value).toBe(0.5);
    // 6 tasks of two dispatches and 6 of one at 0.1 each
    expect(cell?.cost_per_task_usd.value).toBeCloseTo((6 * 0.2 + 6 * 0.1) / 12);
  });

  it("counts a task as escalated by the shared rule (D-cv): a Low start after 1 failed round, Mid after 2", () => {
    const log = new RunLog();
    // logs from before D-cv: later rounds ran on the start tier, logged with reason `rule`
    const rounds = (task: string, size: "S" | "M", tier: ModelTier, n: number): void => {
      log.taskCreated(task, "backend", [], { size, risk: "low", riskTags: [] });
      for (let round = 1; round <= n; round += 1) {
        log.status(task, round === 1 ? "tests_authored" : "fixing", "building", round);
        log.dispatch("engineer", { task, tier, tierReason: "rule" });
        log.gate(task, round === n);
      }
    };
    for (let i = 1; i <= 10; i += 1) rounds(`T-${String(i)}`, "S", "low", i <= 6 ? 2 : 1);
    for (let i = 1; i <= 10; i += 1) rounds(`T-${String(10 + i)}`, "M", "mid", i <= 3 ? 3 : 2);
    const card = scorecardOf(log);
    expect(card.cells.map((c) => [c.size, c.start_tier, c.tasks, c.escalated.value])).toEqual([
      // escalationSteps("low", 2) = 1: a second round on a Low start is an escalation
      ["S", "low", 10, 0.6],
      // escalationSteps("mid", 2) = 0, escalationSteps("mid", 3) = 1
      ["M", "mid", 10, 0.3],
    ]);
  });

  it("classes risk with taskRiskClass and keeps modes, hosts and start reasons apart", () => {
    const log = new RunLog();
    routedTask(log, "T-1", { riskTags: ["ui"], tier: "mid" });
    routedTask(log, "T-2", { riskTags: ["auth"], tier: "top" });
    routedTask(log, "T-3", { risk: "high", tier: "top" });
    routedTask(log, "T-4", { size: "M", tier: "low", reason: "planner_hint" });
    routedTask(log, "T-5", { role: "qa", mode: "author", tier: "mid" });
    routedTask(log, "T-6", { role: "qa", mode: "judge", tier: "low" });
    const cells = scorecardOf(log).cells.map((c) => [
      c.role,
      c.mode ?? "",
      c.size,
      c.risk,
      c.start_tier,
      c.start_reason,
    ]);
    expect(cells).toEqual([
      ["engineer", "", "S", "tagged", "mid", "rule"],
      ["engineer", "", "S", "high", "top", "rule"],
      ["engineer", "", "M", "none", "low", "planner_hint"],
      ["qa", "author", "S", "none", "mid", "rule"],
      ["qa", "judge", "S", "none", "low", "rule"],
    ]);
    expect(scorecardOf(log).cells[1]?.tasks).toBe(2);
  });

  it("shows insufficient data below the minimum n, and no cost when a dispatch was unpriced", () => {
    const log = new RunLog();
    for (let i = 1; i <= 12; i += 1)
      routedTask(log, `T-${String(i)}`, { cost: i <= 3 ? null : 0.1 });
    const [cell] = scorecardOf(log).cells;
    expect(cell?.cost_per_task_usd).toEqual({ value: null, ci_low: null, ci_high: null, n: 9 });
    const small = new RunLog();
    for (let i = 1; i <= 3; i += 1) routedTask(small, `T-${String(i)}`);
    const [few] = scorecardOf(small).cells;
    expect(few?.escalated).toEqual({ value: null, ci_low: null, ci_high: null, n: 3 });
    expect(few?.metrics.first_round_gate_pass?.value).toBeNull();
  });

  it("skips logs written before 5.4.0 (no tier) and leaves replay trials out (reading 177)", () => {
    const log = new RunLog();
    log.taskCreated("T-1", "backend", [], { size: "S", risk: "low" });
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", true);
    log.taskCreated("T-2", "backend", [], { size: "S", risk: "low" });
    log.dispatch("engineer", {
      task: "T-2",
      tier: "top",
      tierReason: "rule",
      replay: { proposal: "p-1", task: "r0:T-2", arm: "a", trial: 1 },
    });
    log.dispatch("engineer", { task: "T-2", tier: "low", tierReason: "rule" });
    log.gate("T-2", true);
    const card = scorecardOf(log);
    expect(card.cells.map((c) => [c.start_tier, c.tasks])).toEqual([["low", 1]]);
  });

  it("skips a task whose first dispatch names no start tier (escalation, budget drop, untiered)", () => {
    const log = new RunLog();
    routedTask(log, "T-1", { reason: "budget_drop" });
    routedTask(log, "T-2", { reason: "escalation", tier: "mid" });
    // the first dispatch logged before 5.4.0, a later one tiered: the whole task is skipped
    log.taskCreated("T-3", "backend", [], { size: "S", risk: "low" });
    log.dispatch("engineer", { task: "T-3" });
    log.gate("T-3", false);
    log.dispatch("engineer", { task: "T-3", tier: "low", tierReason: "rule" });
    log.gate("T-3", true);
    routedTask(log, "T-4");
    const card = scorecardOf(log);
    expect(card.cells.map((c) => [c.start_tier, c.start_reason, c.tasks])).toEqual([
      ["low", "rule", 1],
    ]);
  });

  it("skips a start the project's bounds clamped, but keeps QA author's floor", () => {
    const log = new RunLog();
    // routing.min_tier mid moved an S task off the table's low
    routedTask(log, "T-1", { tier: "mid", clamped: true });
    routedTask(log, "T-2", { tier: "low" });
    // QA author on S/none: the table says low, its floor says mid
    routedTask(log, "T-3", { role: "qa", mode: "author", tier: "mid", clamped: true });
    // QA author moved to top by a project bound, not its floor: skipped
    routedTask(log, "T-4", { role: "qa", mode: "author", size: "L", tier: "top", clamped: true });
    const cells = scorecardOf(log).cells.map((c) => [c.role, c.mode ?? "", c.start_tier, c.tasks]);
    expect(cells).toEqual([
      ["engineer", "", "low", 1],
      ["qa", "author", "mid", 1],
    ]);
  });

  it("is written at LOOKBACK_REPO.routingScorecard", async () => {
    const root = await tempDir("routing");
    const log = new RunLog();
    routedTask(log, "T-1");
    const card = scorecardOf(log);
    expect(await writeRoutingScorecard(root, card)).toBe(LOOKBACK_REPO.routingScorecard);
    const text = await readFile(join(root, LOOKBACK_REPO.routingScorecard), "utf8");
    expect(RoutingScorecardSchema.parse(JSON.parse(text))).toEqual(card);
  });
});

// ------------------------------------------------------------------ proposals

const metric = (value: number | null, n: number) => ({ value, ci_low: null, ci_high: null, n });

/** A scorecard cell with pass rates, an escalation share and a cost. */
const cell = (c: {
  role?: string;
  mode?: string;
  size?: "S" | "M" | "L";
  risk?: "none" | "tagged" | "high";
  tier: ModelTier;
  reason?: "rule" | "planner_hint" | "role";
  tasks?: number;
  pass?: number;
  review?: number;
  escalated?: number;
  cost?: number;
}): RoutingCell => {
  const tasks = c.tasks ?? 12;
  return {
    role: c.role ?? "engineer",
    ...(c.mode === undefined ? {} : { mode: c.mode }),
    host: HOST,
    size: c.size ?? "M",
    risk: c.risk ?? "none",
    start_tier: c.tier,
    start_reason: c.reason ?? "rule",
    tasks,
    metrics: {
      first_round_gate_pass: metric(c.pass ?? 1, tasks),
      ...(c.review === undefined ? {} : { review_pass: metric(c.review, tasks) }),
    },
    escalated: metric(c.escalated ?? 0, tasks),
    cost_per_task_usd: metric(c.cost ?? 0.1, tasks),
  };
};

const card = (cells: RoutingCell[]): RoutingScorecard => ({
  v: 1,
  grader_bundle_sha: BUNDLE,
  window: { from: now.toISOString(), to: now.toISOString() },
  cells,
  written_at: now.toISOString(),
});

describe("routing proposals (D-cn)", () => {
  it("reads the table's start tier, with a role's override and the floors", () => {
    const table = RoutingTableSchema.parse({
      ...DCM,
      roles: { engineer_backend: { by_size: { M: "low" }, tagged_floor: "low" } },
    });
    expect(routedStartTier(table, "engineer", "S", "none")).toBe("low");
    expect(routedStartTier(table, "engineer", "S", "tagged")).toBe("mid");
    expect(routedStartTier(table, "engineer", "S", "high")).toBe("top");
    expect(routedStartTier(table, "engineer", "L", "tagged")).toBe("top");
    expect(routedStartTier(table, "engineer_backend", "M", "none")).toBe("low");
    expect(routedStartTier(table, "engineer_backend", "M", "tagged")).toBe("low");
  });

  it("reads a high-risk cell as engine core's router does: by size, floored on high_floor alone", () => {
    // core/routing.ts `ruleTier`: a high-risk task starts on the higher of `by_size` and
    // `high_floor`; `tagged_floor` is not its floor (a `risk: high` task may carry no tag)
    const table = RoutingTableSchema.parse({
      ...DCM,
      tagged_floor: "top",
      high_floor: "mid",
      roles: { qa: { high_floor: "low" } },
    });
    expect(routedStartTier(table, "engineer", "S", "tagged")).toBe("top");
    expect(routedStartTier(table, "engineer", "S", "high")).toBe("mid");
    expect(routedStartTier(table, "engineer", "L", "high")).toBe("top");
    expect(routedStartTier(table, "qa", "S", "high")).toBe("low");
    expect(routedStartTier(table, "qa", "M", "high")).toBe("mid");
  });

  it("proposes a cheaper start when the cheaper tier's pass rates are within the margin", () => {
    const margin = LOOKBACK_LIMITS.routingQualityMarginPct / 100;
    const out = routingProposals(
      card([
        cell({ tier: "mid", pass: 0.95, review: 0.9 }),
        cell({ tier: "low", reason: "role", pass: 0.95 - margin, review: 0.9, cost: 0.03 }),
      ]),
      DCM,
    );
    expect(out.changes.map((c) => [c.subject, c.direction, c.from, c.to, c.scope])).toEqual([
      [routingConfigSubject("engineer", "M", "none"), "cheaper", "mid", "low", "role"],
    ]);
    // one role differs: its own override, the shared cells unchanged
    expect(out.table).toEqual({
      ...DCM,
      roles: { engineer: { by_size: { M: "low" } } },
    });
    expect(RoutingTableSchema.safeParse(out.table).success).toBe(true);
    expect(out.facts).toMatchObject([
      {
        type: "improvement",
        kind: "config",
        subject: "routing.engineer.M.none",
        role: "engineer",
        metrics: {
          "routing.from_tier": 1,
          "routing.to_tier": 0,
          "routing.shared": 0,
          "routing.replay_planned": 0,
          "routing.lifted": 0,
          "routing.tasks.current": 12,
          "routing.first_round_gate_pass.current": 0.95,
          "routing.cost_per_task_usd.candidate": 0.03,
        },
        at: now.toISOString(),
      },
    ]);
    for (const name of Object.keys(out.facts[0]?.metrics ?? {}))
      expect(name).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
  });

  it("keeps the start tier when the cheaper tier misses the margin or keeps escalating", () => {
    for (const cheaper of [
      cell({ tier: "low", reason: "role", pass: 0.8 }),
      cell({ tier: "low", reason: "role", pass: 1, review: 0.7 }),
      cell({ tier: "low", reason: "role", pass: 1, escalated: 0.6 }),
    ]) {
      const out = routingProposals(
        card([cell({ tier: "mid", pass: 1, review: 0.95 }), cheaper]),
        DCM,
      );
      expect(out.changes).toEqual([]);
      expect(out.table).toBeNull();
    }
  });

  it("proposes a higher start for a start tier that keeps escalating", () => {
    const share = LOOKBACK_LIMITS.routingEscalationPct / 100;
    const out = routingProposals(card([cell({ size: "S", tier: "low", escalated: share })]), DCM);
    expect(out.changes.map((c) => [c.subject, c.direction, c.from, c.to])).toEqual([
      ["routing.engineer.S.none", "higher", "low", "mid"],
    ]);
    expect(out.table?.roles).toEqual({ engineer: { by_size: { S: "mid" } } });
    const below = routingProposals(
      card([cell({ size: "S", tier: "low", escalated: share - 0.01 })]),
      DCM,
    );
    expect(below.changes).toEqual([]);
  });

  it("lifts the cells that floor on a raised start, and names them", () => {
    // M/none mid -> top raises by_size.M, which M tagged floors on
    const m = routingProposals(card([cell({ size: "M", tier: "mid", escalated: 0.9 })]), DCM);
    expect(m.dropped).toEqual([]);
    expect(m.changes.map((c) => [c.subject, c.direction, c.from, c.to, c.lifted])).toEqual([
      [
        "routing.engineer.M.none",
        "higher",
        "mid",
        "top",
        [{ size: "M", risk: "tagged", from: "mid", to: "top" }],
      ],
    ]);
    expect(m.table?.roles).toEqual({ engineer: { by_size: { M: "top" } } });
    expect(m.facts[0]?.metrics).toMatchObject({
      "routing.lifted": 1,
      "routing.lifted.m_tagged": 2,
    });
    for (const name of Object.keys(m.facts[0]?.metrics ?? {}))
      expect(name).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
    // S tagged mid -> top raises tagged_floor, which every size's tagged cell floors on
    const tagged = routingProposals(
      card([cell({ size: "S", risk: "tagged", tier: "mid", escalated: 0.9 })]),
      DCM,
    );
    expect(tagged.changes.map((c) => [c.subject, c.to, c.lifted])).toEqual([
      ["routing.engineer.S.tagged", "top", [{ size: "M", risk: "tagged", from: "mid", to: "top" }]],
    ]);
    expect(tagged.table?.roles).toEqual({ engineer: { tagged_floor: "top" } });
    const mTagged = routingProposals(
      card([cell({ size: "M", risk: "tagged", tier: "mid", escalated: 0.9 })]),
      DCM,
    );
    expect(mTagged.changes.map((c) => [c.subject, c.to, c.lifted.map((l) => l.size)])).toEqual([
      ["routing.engineer.M.tagged", "top", ["S"]],
    ]);
  });

  it("raises the shared cell, lifts included, when two roles keep escalating on M/none", () => {
    const out = routingProposals(
      card([
        cell({ size: "M", tier: "mid", escalated: 0.7 }),
        cell({ role: "engineer_frontend", size: "M", tier: "mid", escalated: 0.8 }),
      ]),
      DCM,
    );
    expect(out.dropped).toEqual([]);
    expect(out.changes.map((c) => [c.role, c.scope, c.to, c.lifted.length])).toEqual([
      ["engineer", "shared", "top", 1],
      ["engineer_frontend", "shared", "top", 1],
    ]);
    expect(out.table?.by_size).toEqual({ S: "low", M: "top", L: "top" });
  });

  it("drops QA author's escalation on S/none: its floored start is two tiers above the table's", () => {
    const author = cell({ role: "qa", mode: "author", size: "S", tier: "mid", escalated: 0.9 });
    const out = routingProposals(card([author]), DCM);
    expect(out.changes).toEqual([]);
    expect(out.dropped.map((d) => d.subject)).toEqual(["routing.qa.S.none"]);
    expect(out.dropped[0]?.reason).toContain("two tiers");
  });

  it("proposes producer cells only (D-cu): a reviewer's cell is informational", () => {
    // every reviewer starts on its own role.yaml tier, so the table cannot move it
    const reviewers = [
      cell({ role: "spec_verifier", size: "S", tier: "low", escalated: 0.9 }),
      cell({ role: "qa", mode: "judge", size: "S", tier: "low", escalated: 0.9 }),
      cell({ role: "security", mode: "verify", size: "M", tier: "mid", escalated: 0.9 }),
      cell({ role: "lens_api", size: "L", tier: "top", pass: 1 }),
      cell({ role: "lens_api", size: "L", tier: "mid", reason: "role", pass: 1 }),
    ];
    expect(routingProposals(card(reviewers), DCM)).toEqual({
      table: null,
      changes: [],
      facts: [],
      dropped: [],
    });
    // nor does a reviewer back or object to a producer's change: the Engineer's stays its own
    const out = routingProposals(
      card([cell({ size: "S", tier: "low", escalated: 0.8 }), ...reviewers]),
      DCM,
    );
    expect(out.changes.map((c) => [c.role, c.subject, c.scope])).toEqual([
      ["engineer", "routing.engineer.S.none", "role"],
    ]);
    // QA in author mode is a producer
    const qa = routingProposals(
      card([
        cell({ role: "qa", mode: "author", size: "M", tier: "mid", escalated: 0.9 }),
        cell({ role: "qa", mode: "judge", size: "M", tier: "mid", escalated: 0 }),
      ]),
      DCM,
    );
    expect(qa.changes.map((c) => [c.subject, c.from, c.to])).toEqual([
      ["routing.qa.M.none", "mid", "top"],
    ]);
    expect(qa.facts[0]?.metrics).toMatchObject({
      "routing.from_tier": 1,
      "routing.current_tier": 1,
      "routing.to_tier": 2,
    });
  });

  it("reads no cell below routingMinTasks tasks", () => {
    const few = LOOKBACK_LIMITS.routingMinTasks - 1;
    const out = routingProposals(
      card([cell({ size: "S", tier: "low", escalated: 0.9, tasks: few })]),
      DCM,
    );
    expect(out).toEqual({ table: null, changes: [], facts: [], dropped: [] });
  });

  it("changes the shared cell when two roles show the same change and none objects", () => {
    const out = routingProposals(
      card([
        cell({ size: "S", tier: "low", escalated: 0.7 }),
        cell({ role: "engineer_backend", size: "S", tier: "low", escalated: 0.8 }),
      ]),
      DCM,
    );
    expect(out.changes.map((c) => [c.role, c.scope, c.to])).toEqual([
      ["engineer", "shared", "mid"],
      ["engineer_backend", "shared", "mid"],
    ]);
    expect(out.table).toEqual({
      ...DCM,
      by_size: { S: "mid", M: "mid", L: "top" },
    });
    expect(out.facts.map((f) => f.subject)).toEqual([
      "routing.engineer.S.none",
      "routing.engineer_backend.S.none",
    ]);
    // a third producer whose S cell is fine keeps the change per role
    const objected = routingProposals(
      card([
        cell({ size: "S", tier: "low", escalated: 0.7 }),
        cell({ role: "engineer_backend", size: "S", tier: "low", escalated: 0.8 }),
        cell({ role: "engineer_frontend", size: "S", tier: "low", escalated: 0 }),
      ]),
      DCM,
    );
    expect(objected.changes.map((c) => c.scope)).toEqual(["role", "role"]);
    expect(objected.table?.by_size).toEqual(DCM.by_size);
    expect(objected.table?.roles).toEqual({
      engineer: { by_size: { S: "mid" } },
      engineer_backend: { by_size: { S: "mid" } },
    });
  });

  it("never proposes QA author below its floor", () => {
    const out = routingProposals(
      card([
        cell({ role: "qa", mode: "author", size: "M", tier: "mid", pass: 1 }),
        cell({
          role: "qa",
          mode: "author",
          size: "M",
          tier: "low",
          reason: "role",
          pass: 1,
        }),
      ]),
      DCM,
    );
    expect(out.changes).toEqual([]);
  });

  it("drops a change the table cannot make without moving another cell", () => {
    // high_floor is shared by every size: S high on mid would also start M high on mid
    const out = routingProposals(
      card([
        cell({ size: "S", risk: "high", tier: "top", pass: 1 }),
        cell({ size: "S", risk: "high", tier: "mid", reason: "role", pass: 1 }),
      ]),
      DCM,
    );
    expect(out.changes).toEqual([]);
    expect(out.table).toBeNull();
    expect(out.dropped.map((d) => d.subject)).toEqual(["routing.engineer.S.high"]);
    expect(out.dropped[0]?.reason).toContain("M.high");
  });

  it("never takes a Planner-hinted cell as a cheaper tier's evidence (a biased sample)", () => {
    const current = cell({ tier: "mid", pass: 0.95 });
    const hinted = cell({ tier: "low", reason: "planner_hint", pass: 0.95, tasks: 40 });
    const out = routingProposals(card([current, hinted]), DCM);
    expect(out).toEqual({ table: null, changes: [], facts: [], dropped: [] });
    // the same numbers from a `routing.start: role` project are evidence
    const role = routingProposals(card([current, { ...hinted, start_reason: "role" }]), DCM);
    expect(role.changes.map((c) => [c.subject, c.to])).toEqual([
      ["routing.engineer.M.none", "low"],
    ]);
    // a hinted cell beside a rule or role cell of the same tier is not what is read
    const mixed = routingProposals(
      card([current, hinted, cell({ tier: "low", reason: "role", pass: 0.5, tasks: 10 })]),
      DCM,
    );
    expect(mixed.changes).toEqual([]);
  });

  it("blocks a cheaper start when another host compared the cheaper tier and found it worse", () => {
    const other = { host: "codex" as const };
    const out = routingProposals(
      card([
        cell({ tier: "mid", pass: 0.95 }),
        cell({ tier: "low", reason: "role", pass: 0.95 }),
        { ...cell({ tier: "mid", pass: 0.95 }), ...other },
        { ...cell({ tier: "low", reason: "role", pass: 0.5 }), ...other },
      ]),
      DCM,
    );
    expect(out).toEqual({ table: null, changes: [], facts: [], dropped: [] });
  });

  it("raises the start when one host keeps escalating and another is steady (safety first)", () => {
    const out = routingProposals(
      card([
        cell({ size: "S", tier: "low", escalated: 0.8 }),
        { ...cell({ size: "S", tier: "low", escalated: 0 }), host: "codex" as const },
      ]),
      DCM,
    );
    expect(out.changes.map((c) => [c.subject, c.direction, c.from, c.to, c.scope])).toEqual([
      ["routing.engineer.S.none", "higher", "low", "mid", "role"],
    ]);
    // the evidence named is the escalating host's cell
    expect(out.changes[0]?.current.host).toBe(HOST);
  });

  it("proposes the cheapest tier that matches quality when several do", () => {
    // tagged_floor top: lowering L/none moves no other cell
    const table = RoutingTableSchema.parse({ ...DCM, tagged_floor: "top" });
    const both = routingProposals(
      card([
        cell({ size: "L", tier: "top", pass: 0.95 }),
        cell({ size: "L", tier: "mid", reason: "role", pass: 0.95 }),
        cell({ size: "L", tier: "low", reason: "role", pass: 0.95 }),
      ]),
      table,
    );
    expect(both.dropped).toEqual([]);
    expect(both.changes.map((c) => [c.subject, c.from, c.to, c.candidate?.start_tier])).toEqual([
      ["routing.engineer.L.none", "top", "low", "low"],
    ]);
    expect(both.table?.roles).toEqual({ engineer: { by_size: { L: "low" } } });
    // low falls short: mid is proposed
    const midOnly = routingProposals(
      card([
        cell({ size: "L", tier: "top", pass: 0.95 }),
        cell({ size: "L", tier: "mid", reason: "role", pass: 0.95 }),
        cell({ size: "L", tier: "low", reason: "role", pass: 0.5 }),
      ]),
      table,
    );
    expect(midOnly.changes.map((c) => [c.subject, c.to])).toEqual([
      ["routing.engineer.L.none", "mid"],
    ]);
  });

  it("selects held-out tasks of the current cell for a tier replay, failures first", () => {
    const log = new RunLog();
    let n = 0;
    for (let i = 1; n < 6 && i < 1000; i += 1) {
      const action = `act-${String(i)}`;
      if (traceSplit({ run: "r1", trace: action }) !== "holdout") continue;
      n += 1;
      routedTask(log, `T-${String(n)}`, { action, escalate: n <= 2 });
    }
    const tasks = routingReplayTasks({
      history: log.events,
      cell: { role: "engineer", host: HOST, size: "S", risk: "none", start_tier: "low" },
      pace: { failureTasks: 1, regressionTasks: 2 },
    });
    expect(tasks.map((t) => [t.task, t.regressionSet])).toEqual([
      ["T-1", false],
      ["T-3", true],
      ["T-4", true],
    ]);
  });

  it("takes a task the shared rule escalated as a failure of its start tier (D-cv)", () => {
    const log = new RunLog();
    let n = 0;
    for (let i = 1; n < 2 && i < 1000; i += 1) {
      const action = `act-${String(i)}`;
      if (traceSplit({ run: "r1", trace: action }) !== "holdout") continue;
      n += 1;
      const task = `T-${String(n)}`;
      log.taskCreated(task, "backend", [], { size: "S", risk: "low", riskTags: [] });
      log.status(task, "tests_authored", "building", 1);
      log.dispatch("engineer", { task, tier: "low", tierReason: "rule", action });
      log.gate(task, n === 2);
      if (n === 1) {
        // a log from before D-cv: the second round ran on Low again
        log.status(task, "verifying", "fixing", 2);
        log.dispatch("engineer", { task, tier: "low", tierReason: "rule" });
        log.gate(task, true);
      }
    }
    const tasks = routingReplayTasks({
      history: log.events,
      cell: { role: "engineer", host: HOST, size: "S", risk: "none", start_tier: "low" },
    });
    expect(tasks.map((t) => [t.task, t.regressionSet])).toEqual([
      ["T-1", false],
      ["T-2", true],
    ]);
  });
});
