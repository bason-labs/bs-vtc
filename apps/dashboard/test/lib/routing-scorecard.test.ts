import { describe, expect, it } from "vitest";
import { LOOKBACK_LIMITS, LOOKBACK_REPO, TaskRiskClassSchema } from "@vtc/shared";
import {
  readRoutingScorecard,
  RISK_CLASS_LABELS,
  routingScorecardView,
} from "@/lib/routing-scorecard";
import { jsonArtifact, ROUTING_SCORECARD } from "../dev-samples";

/**
 * The routing scorecard (D-cn; spine §5 reading 219): quality per token for each (role, mode,
 * host, size, risk class, start tier) cell, which routing PRs use as chart evidence.
 */
const PATH = LOOKBACK_REPO.routingScorecard;

describe("readRoutingScorecard", () => {
  it("reads the routing scorecard and refuses one that breaks the contract", () => {
    expect(readRoutingScorecard(jsonArtifact(PATH, ROUTING_SCORECARD)).ok).toBe(true);
    const bad = readRoutingScorecard(jsonArtifact(PATH, { ...ROUTING_SCORECARD, v: 2 }));
    expect(!bad.ok && bad.problem).toMatch(/^v: /);
  });
});

describe("routingScorecardView", () => {
  const view = routingScorecardView(ROUTING_SCORECARD);

  it("names every risk class", () => {
    for (const r of TaskRiskClassSchema.options) expect(RISK_CLASS_LABELS[r]).not.toBe("");
  });

  it("groups cells by role, mode and host", () => {
    expect(view.groups.map((g) => g.title)).toEqual([
      "engineer · claude-code",
      "qa (author) · codex",
    ]);
  });

  it("orders a group's cells by size, risk and start tier", () => {
    const engineer = view.groups[0]!;
    expect(engineer.cells.map((c) => `${c.size} ${c.risk} ${c.tier} ${c.start}`)).toEqual([
      "S no risk tag Low routing table",
      "S no risk tag Mid routing table",
      "M no risk tag Top Planner hint",
      "M risk tag Mid routing table",
      "L high risk Top routing table",
    ]);
  });

  it("shows pass rates with their 95% interval, tokens per success and cost per task", () => {
    const cheap = view.groups[0]!.cells[0]!;
    expect(cheap.tasks).toBe("14 tasks");
    expect(cheap.read).toBe(true);
    expect(cheap.gatePass).toMatchObject({
      value: "71%",
      interval: "45–88%",
      mark: { value: 0.7143, low: 0.4535, high: 0.8828 },
    });
    expect(cheap.reviewPass?.value).toBe("86%");
    expect(cheap.tokensPerSuccess).toMatchObject({ value: "182,000 tokens", mark: null });
    expect(cheap.escalated).toMatchObject({ value: "21%", interval: "8–48%" });
    expect(cheap.costPerTask).toMatchObject({ value: "$0.42", interval: null });
  });

  it(`says a cell below ${String(LOOKBACK_LIMITS.routingMinTasks)} tasks is not read yet, and shows no value`, () => {
    const large = view.groups[0]!.cells.at(-1)!;
    expect(large.read).toBe(false);
    expect(large.tasks).toBe("4 tasks");
    expect(large.gatePass).toMatchObject({
      value: "insufficient data",
      interval: null,
      mark: null,
    });
    expect(large.costPerTask?.value).toBe("insufficient data");
  });

  it("says unpriced when a read cell has no cost", () => {
    const qa = view.groups[1]!.cells[0]!;
    expect(qa.read).toBe(true);
    expect(qa.costPerTask?.value).toBe("unpriced");
  });

  it("shows a metric the cell does not record as absent", () => {
    const cell = ROUTING_SCORECARD.cells[0]!;
    const { review_pass: _dropped, ...metrics } = cell.metrics;
    const v = routingScorecardView({ ...ROUTING_SCORECARD, cells: [{ ...cell, metrics }] });
    expect(v.groups[0]?.cells[0]?.reviewPass).toBeNull();
  });

  it("states the window and the grader bundle", () => {
    expect(view.grader).toBe("dddddddddddd");
    expect(view.window.from).toBe(ROUTING_SCORECARD.window.from);
  });
});
