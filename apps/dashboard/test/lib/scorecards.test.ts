import { describe, expect, it } from "vitest";
import { ScorecardIndexSchema, ScorecardMetricIdSchema } from "@vtc/shared";
import {
  groupScorecards,
  lookbackActivity,
  METRIC_LABELS,
  metricRows,
  readScorecard,
  readScorecardIndex,
  refusedScorecardPaths,
} from "@/lib/scorecards";
import { firstSample, SAMPLE_EVENTS, sampleEvent, variant } from "../golden-samples";
import { ENGINEER_SCORECARD, jsonArtifact, SCORECARD_INDEX } from "../wave3-fixtures";

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
    expect(refusedScorecardPaths(SCORECARD_INDEX)).toEqual([]);
  });

  it("leaves out entries whose path is not under the scorecards directory", () => {
    const [entry] = SCORECARD_INDEX.scorecards;
    const index = ScorecardIndexSchema.parse({
      ...SCORECARD_INDEX,
      scorecards: [
        ...SCORECARD_INDEX.scorecards,
        { ...entry, path: ".vtc/spec/spec.md" },
        { ...entry, path: ".vtc/state/run.json" },
      ],
    });
    const versions = groupScorecards(index).flatMap((g) => g.versions.map((v) => v.path));
    expect(versions).toEqual(
      groupScorecards(SCORECARD_INDEX).flatMap((g) => g.versions.map((v) => v.path)),
    );
    expect(refusedScorecardPaths(index)).toEqual([".vtc/spec/spec.md", ".vtc/state/run.json"]);
  });
});

describe("lookbackActivity (lookback.* events, golden samples)", () => {
  const activity = lookbackActivity(SAMPLE_EVENTS);
  const evaluated = firstSample("lookback.canary_evaluated");

  it("keeps the latest canary state per role and host", () => {
    const later = variant(evaluated, 91, { verdict: "continue", reason: "no trigger yet" });
    const canaries = lookbackActivity([...SAMPLE_EVENTS, later]).canaries;
    expect(canaries).toHaveLength(1);
    expect(canaries[0]).toMatchObject({ target: "engineer · codex", reason: "no trigger yet" });
    expect(activity.canaries[0]?.verdict).toMatchObject({ tone: "danger" });
    expect(activity.canaries[0]?.arms).toEqual([
      "candidate 5637b302: 6 dispatches, 2 escalations, 0 cap hits, 15,000 tokens per dispatch",
      "baseline 66bd4895: 6 dispatches, 0 escalations, 0 cap hits, 13,333 tokens per dispatch",
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
    expect(replay.title).toBe("Replay of p-engineer-1: inconclusive, not an improvement");
    expect(replay.path).toBe(".vtc/lookback/replays/p-engineer-1.json");
    expect(replay.detail).toBeNull();
    expect(activity.items[0]?.detail).toMatch(/revert of bbbbbbbb.*T-1/);
  });

  it("says an improvement ships through VTC's own PR once a human merges it (D-cb)", () => {
    const improve = variant(firstSample("lookback.replay_finished"), 92, { verdict: "improve" });
    const [item] = lookbackActivity([improve]).items;
    expect(item?.title).toBe("Replay of p-engineer-1: improves");
    expect(item?.detail).toMatch(/pull request to VTC's own repo/);
    expect(item?.detail).toMatch(/next VTC release ships the change once a human merges it/);
  });

  it("shows the failures left without an attribution while no AI tiebreak runs (reading 182)", () => {
    const items = lookbackActivity([
      sampleEvent(95, "lookback.unattributed", { failures: 3, tasks: ["T-2", "T-4"] }),
    ]).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "lookback.unattributed",
      tone: "warn",
      title: "3 failures left unattributed",
      path: null,
    });
    expect(items[0]?.detail).toMatch(/no AI tiebreak.*no scorecard.*T-2, T-4/);
  });

  it("no longer says a Claude-led run cannot start a canary (D-cg, reading 201)", () => {
    const claude = variant(firstSample("lookback.dispatched"), 96, {
      target_role: "spec_verifier",
      target_host: "claude-code",
      train_failures: 2,
    });
    const result = lookbackActivity([claude]);
    expect(result).not.toHaveProperty("noCanary");
    expect(result.items[0]?.detail).toBe("2 attributed train failures");
  });
});
