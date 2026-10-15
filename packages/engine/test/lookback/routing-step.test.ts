/**
 * Lookback's routing step at RETRO (D-cn; spine §5 reading 219: "RETRO writes a routing
 * scorecard"): the function engine core's daemon calls through its `RoutingLookback` seam
 * (`wireLookback(..., { propose, found })`). It writes the routing scorecard and returns the
 * routing-table cells it proposes to change, which the daemon turns into `config` facts.
 */
import {
  LOOKBACK_REPO,
  RoutingScorecardSchema,
  RoutingTableSchema,
  type RoutingScorecard,
  type RoutingTable,
  type VtcEvent,
} from "@vtc/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routingConfigFact, type RoutingLookback } from "../../src/daemon/index.js";
import { upstreamModuleFact } from "../../src/daemon/upstream-bridge.js";
import {
  appendAttributions,
  attributeRun,
  computeRoutingScorecard,
  lookbackRoutingStep,
  readAttributions,
  routingProposalCells,
  routingProposals,
  type RoutingCell,
} from "../../src/lookback/index.js";
import { evaluateTrigger } from "../../src/upstream/index.js";
import { HOST, lockedShaFor, RunLog, tempDir } from "./log.js";

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

/** `n` S tasks (no risk tag) the Engineer started on Low; the first `escalated` escalated to Mid. */
const lowStarts = (n: number, escalated: number, role = "engineer"): VtcEvent[] => {
  const log = new RunLog();
  for (let i = 1; i <= n; i += 1) {
    const task = `T-${String(i)}`;
    log.taskCreated(task, "backend", [], { size: "S", risk: "low", riskTags: [] });
    log.dispatch(role, { task, tier: "low", tierReason: "rule" });
    log.gate(task, i > escalated);
    if (i <= escalated) {
      log.dispatch(role, { task, tier: "mid", tierReason: "escalation" });
      log.gate(task, true);
    }
  }
  return log.events;
};

describe("the routing step at RETRO (D-cn, engine core's RoutingLookback seam)", () => {
  it("fits engine core's seam", () => {
    const step: RoutingLookback = lookbackRoutingStep;
    expect(typeof step).toBe("function");
  });

  it("writes the routing scorecard and returns the cell it proposes to change", async () => {
    const root = await tempDir("routing-step");
    const history = lowStarts(12, 7);
    const cells = await lookbackRoutingStep({
      table: DCM,
      projectRoot: root,
      history,
      graderBundleSha: BUNDLE,
      now,
    });
    const written = RoutingScorecardSchema.parse(
      JSON.parse(await readFile(join(root, LOOKBACK_REPO.routingScorecard), "utf8")) as unknown,
    );
    expect(written).toEqual(computeRoutingScorecard({ history, graderBundleSha: BUNDLE, now }));
    expect(cells).toHaveLength(1);
    const [cell] = cells;
    expect(cell).toMatchObject({ role: "engineer", size: "S", risk: "none" });
    expect(cell?.metrics).toMatchObject({
      "routing.from_tier": 0,
      "routing.to_tier": 1,
      "routing.shared": 0,
      "routing.replay_planned": 0,
      "routing.tasks.current": 12,
    });
    // the edit the PR makes, in VTC's vocabulary only
    expect(cell?.detail).toContain("start on mid instead of low");
    expect(cell?.detail).toContain('set roles.engineer.by_size.S to "mid"');
    expect(cell?.detail).toContain("DEFAULT_ROUTING_TABLE");
    expect(cell?.detail).toContain("58% of 12 tasks escalated");
  });

  it("returns nothing and writes nothing for a history without tier records", async () => {
    const root = await tempDir("routing-step-none");
    const log = new RunLog();
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", true);
    const cells = await lookbackRoutingStep({
      table: DCM,
      projectRoot: root,
      history: log.events,
      graderBundleSha: BUNDLE,
      now,
    });
    expect(cells).toEqual([]);
    await expect(readFile(join(root, LOOKBACK_REPO.routingScorecard), "utf8")).rejects.toThrow();
  });

  it("writes the scorecard but proposes nothing for a start tier that does well", async () => {
    const root = await tempDir("routing-step-steady");
    const cells = await lookbackRoutingStep({
      table: DCM,
      projectRoot: root,
      history: lowStarts(12, 0),
      graderBundleSha: BUNDLE,
      now,
    });
    expect(cells).toEqual([]);
    const written = JSON.parse(
      await readFile(join(root, LOOKBACK_REPO.routingScorecard), "utf8"),
    ) as RoutingScorecard;
    expect(written.cells.map((c) => [c.role, c.start_tier, c.tasks])).toEqual([
      ["engineer", "low", 12],
    ]);
  });

  it("scores tokens per success from the trusted attributions when it can read them", async () => {
    const root = await tempDir("routing-step-attr");
    const log = new RunLog();
    for (let i = 1; i <= 12; i += 1) {
      const task = `T-${String(i)}`;
      log.taskCreated(task, "backend", [], { size: "S", risk: "low", riskTags: [] });
      log.dispatch("engineer", { task, tier: "low", tierReason: "rule" });
      log.gate(task, i > 4);
    }
    const { attributions } = attributeRun({ events: log.events, lockedShaFor, now });
    expect(attributions.length).toBeGreaterThan(0);
    await appendAttributions(root, attributions);
    await lookbackRoutingStep({
      table: DCM,
      projectRoot: root,
      history: log.events,
      graderBundleSha: BUNDLE,
      now,
      lockedShaFor,
    });
    const written = JSON.parse(
      await readFile(join(root, LOOKBACK_REPO.routingScorecard), "utf8"),
    ) as RoutingScorecard;
    const trusted = await readAttributions(root, { history: log.events, lockedShaFor });
    expect(written).toEqual(
      computeRoutingScorecard({
        history: log.events,
        attributions: trusted,
        graderBundleSha: BUNDLE,
        now,
      }),
    );
    const blind = computeRoutingScorecard({ history: log.events, graderBundleSha: BUNDLE, now });
    expect(written.cells[0]?.metrics.tokens_per_success?.value).not.toBe(
      blind.cells[0]?.metrics.tokens_per_success?.value,
    );
  });

  it("hands the upstream module a config improvement fingerprinted by the table cell", async () => {
    const root = await tempDir("routing-step-fact");
    const at = now.toISOString();
    const [cell] = await lookbackRoutingStep({
      table: DCM,
      projectRoot: root,
      history: lowStarts(12, 7),
      graderBundleSha: BUNDLE,
      now,
    });
    if (cell === undefined) throw new Error("no proposal");
    const fact = routingConfigFact("r1", cell, at);
    const mapped = upstreamModuleFact(fact);
    expect(mapped).toMatchObject({
      type: "improvement",
      kind: "config",
      subject: "routing.engineer.S.none",
    });
    if (mapped === null) throw new Error("the bridge does not take the fact");
    const item = evaluateTrigger(mapped, { vtcVersion: "0.5.0" });
    expect(item).toMatchObject({ target: "upstream", kind: "config" });
    // the same proposal at the next RETRO dedupes onto the same issue
    const [again] = await lookbackRoutingStep({
      table: DCM,
      projectRoot: root,
      history: lowStarts(13, 8),
      graderBundleSha: BUNDLE,
      now,
    });
    if (again === undefined) throw new Error("no proposal");
    const second = upstreamModuleFact(routingConfigFact("r2", again, at));
    if (second === null) throw new Error("the bridge does not take the fact");
    expect(evaluateTrigger(second, { vtcVersion: "0.5.0" })?.fingerprint).toBe(item?.fingerprint);
  });
});

describe("routingProposalCells (D-cn)", () => {
  const metric = (value: number, n: number) => ({ value, ci_low: null, ci_high: null, n });
  const card = (cells: RoutingScorecard["cells"]): RoutingScorecard => ({
    v: 1,
    grader_bundle_sha: BUNDLE,
    window: { from: now.toISOString(), to: now.toISOString() },
    cells,
    written_at: now.toISOString(),
  });
  const escalating = (role: string, size: "S" | "M", risk: "none" | "tagged"): RoutingCell => ({
    role,
    host: HOST,
    size,
    risk,
    start_tier: size === "S" && risk === "none" ? "low" : "mid",
    start_reason: "rule",
    tasks: 12,
    metrics: { first_round_gate_pass: metric(0.4, 12) },
    escalated: metric(0.75, 12),
    cost_per_task_usd: metric(0.1, 12),
  });

  it("names the shared field when two roles back the change", () => {
    const proposals = routingProposals(
      card([escalating("engineer", "S", "none"), escalating("engineer_backend", "S", "none")]),
      DCM,
    );
    const cells = routingProposalCells(proposals);
    expect(cells.map((c) => [c.role, c.size, c.risk])).toEqual([
      ["engineer", "S", "none"],
      ["engineer_backend", "S", "none"],
    ]);
    for (const c of cells) {
      expect(c.detail).toContain('set by_size.S to "mid"');
      expect(c.detail).not.toContain("roles.");
      expect(c.metrics["routing.shared"]).toBe(1);
    }
    expect(proposals.table).toEqual(
      RoutingTableSchema.parse({
        ...DCM,
        by_size: { S: "mid", M: "mid", L: "top" },
      }),
    );
  });

  it("names a role's floor and the cells a higher floor lifts", () => {
    const proposals = routingProposals(card([{ ...escalating("engineer", "M", "tagged") }]), DCM);
    const [cell] = routingProposalCells(proposals);
    expect(cell?.detail).toContain('set roles.engineer.tagged_floor to "top"');
    expect(cell?.detail).toContain("also starts S/tagged on top");
    expect(cell?.detail.length).toBeLessThanOrEqual(2000);
  });

  it("says what a cheaper start matched", () => {
    const current = { ...escalating("engineer", "M", "none"), escalated: metric(0, 12) };
    current.metrics = { first_round_gate_pass: metric(0.95, 12) };
    const cheaper = {
      ...current,
      start_tier: "low" as const,
      start_reason: "role" as const,
      metrics: { first_round_gate_pass: metric(0.92, 12) },
    };
    const [cell] = routingProposalCells(routingProposals(card([current, cheaper])));
    expect(cell?.detail).toContain('set roles.engineer.by_size.M to "low"');
    expect(cell?.detail).toContain("first_round_gate_pass 0.92 against 0.95");
  });
});
