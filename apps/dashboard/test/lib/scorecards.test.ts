import { describe, expect, it } from "vitest";
import { ScorecardMetricIdSchema } from "@vtc/shared";
import {
  groupScorecards,
  lookbackActivity,
  METRIC_LABELS,
  metricRows,
  readScorecard,
  readScorecardIndex,
} from "@/lib/scorecards";
import {
  ENGINEER_SCORECARD,
  jsonArtifact,
  LOOKBACK_EVENTS,
  SCORECARD_INDEX,
  w3Event,
} from "../wave3-fixtures";

const INDEX_PATH = ".vtc/lookback/scorecards/index.json";

describe("readScorecardIndex / readScorecard", () => {
  it("reads the index Flow Studio lists", () => {
    const read = readScorecardIndex(jsonArtifact(INDEX_PATH, SCORECARD_INDEX));
    expect(read.ok && read.value.scorecards).toHaveLength(2);
  });

  it("refuses a file that breaks the contract and says why", () => {
    const read = readScorecardIndex(jsonArtifact(INDEX_PATH, { v: 2, scorecards: [] }));
    expect(read.ok).toBe(false);
    expect(!read.ok && read.problem).toMatch(/^v: /);
    const bad = readScorecard({ ...jsonArtifact(INDEX_PATH, {}), content: "{" });
    expect(!bad.ok && bad.problem).toBe("not JSON");
  });

  it("drops keys a newer engine added", () => {
    const read = readScorecard(jsonArtifact("x", { ...ENGINEER_SCORECARD, added_later: 1 }));
    expect(read.ok).toBe(true);
  });
});

describe("metricRows (AD-21 rule 5)", () => {
  const rows = metricRows(ENGINEER_SCORECARD.metrics);

  it("shows proportions with n and the 95% Wilson interval", () => {
    expect(rows[0]).toMatchObject({
      id: "first_round_gate_pass",
      value: "63%",
      interval: "95% CI 40–81%",
      n: "n = 24",
      insufficient: false,
    });
  });

  it("shows insufficient data when value is null, with the n it has", () => {
    expect(rows[1]).toMatchObject({
      id: "review_pass",
      value: "insufficient data",
      interval: null,
      n: "n = 4 (needs 10)",
      insufficient: true,
    });
  });

  it("never shows a value below the minimum n, even if one was written", () => {
    const [row] = metricRows({ review_pass: { value: 0.5, ci_low: 0.2, ci_high: 0.8, n: 6 } });
    expect(row).toMatchObject({ value: "insufficient data", insufficient: true });
  });

  it("computes the interval for a proportion written without one", () => {
    const [row] = metricRows({ review_pass: { value: 0.5, ci_low: null, ci_high: null, n: 20 } });
    expect(row?.interval).toBe("95% CI 30–70%");
  });

  it("shows averages, rates and tokens without an interval", () => {
    expect(rows.slice(2).map((r) => [r.id, r.value, r.interval])).toEqual([
      ["rounds_to_done", "1.8 rounds", null],
      ["tokens_per_success", "41,250 tokens", null],
    ]);
  });

  it("names every metric", () => {
    for (const id of ScorecardMetricIdSchema.options) expect(METRIC_LABELS[id].label).not.toBe("");
  });
});

describe("groupScorecards", () => {
  it("groups by role and host, newest first, with short prompt versions", () => {
    const groups = groupScorecards(SCORECARD_INDEX);
    expect(groups.map((g) => g.title)).toEqual(["engineer · claude-code", "qa · codex"]);
    expect(groups[0]?.versions[0]).toMatchObject({
      version: "eeeeeeee",
      editable: "22222222",
      latest: true,
    });
  });
});

describe("lookbackActivity (lookback.* events)", () => {
  const activity = lookbackActivity(LOOKBACK_EVENTS);

  it("keeps the latest canary state per role and host", () => {
    const later = w3Event(91, "lookback.canary_evaluated", {
      ...(LOOKBACK_EVENTS[3]!.data as object),
      verdict: "continue",
      reason: "no trigger yet",
    });
    const canaries = lookbackActivity([...LOOKBACK_EVENTS, later]).canaries;
    expect(canaries).toHaveLength(1);
    expect(canaries[0]).toMatchObject({
      target: "engineer · claude-code",
      reason: "no trigger yet",
    });
    expect(activity.canaries[0]?.verdict).toMatchObject({ tone: "danger" });
    expect(activity.canaries[0]?.arms).toEqual([
      "candidate aaaaaaaa: 6 dispatches, 3 escalations, 1 cap hit, 10,000 tokens per dispatch",
      "baseline bbbbbbbb: 6 dispatches, 1 escalation, 0 cap hits, 9,667 tokens per dispatch",
    ]);
  });

  it("lists the run's lookback events newest first, an inconclusive replay as not improved", () => {
    expect(activity.items.map((i) => i.type)).toEqual([
      "lookback.escaped_defect",
      "lookback.rolled_back",
      "lookback.replay_finished",
      "lookback.proposal_recorded",
      "lookback.dispatched",
    ]);
    const replay = activity.items.find((i) => i.type === "lookback.replay_finished")!;
    expect(replay.title).toBe("Replay of engineer-p1: inconclusive, not an improvement");
    expect(replay.path).toBe(".vtc/lookback/replays/engineer-p1.json");
    expect(activity.items[0]?.detail).toMatch(/revert of cccccccc.*T-1/);
  });
});
