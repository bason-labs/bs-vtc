import { describe, expect, it } from "vitest";
import { EventSchema, type VtcEvent } from "@vtc/shared";
import { createReplayTrialFilter, withoutReplayTrials } from "@/lib/replay-trials";
import { readFixture } from "../fixtures";
import { firstSample, variant } from "../golden-samples";

/** The golden run's own `role.dispatched` and `role.submitted` (action `a-1`). */
const golden = (readFixture("events") as { events: unknown[] }).events.map((e) =>
  EventSchema.parse(e),
);
const dispatched = golden.find((e) => e.type === "role.dispatched")!;
const submitted = golden.find((e) => e.type === "role.submitted")!;

/** A Lookback replay trial of the golden dispatch (spine §5 reading 177), action `a-90`. */
const trial = (seq: number): VtcEvent =>
  variant(
    dispatched,
    seq,
    {
      action_id: "a-90",
      dispatch: "headless",
      purpose: "lookback_replay",
      replay: { proposal: "p-engineer-1", task: "golden-1:T-1", arm: "b", trial: 1 },
    },
    { task: undefined },
  );
const trialSubmitted = (seq: number): VtcEvent =>
  variant(submitted, seq, { action_id: "a-90" }, { task: undefined });
const trialStarted = (seq: number): VtcEvent =>
  variant(
    firstSample("headless.started"),
    seq,
    { action_id: "a-90" },
    { run: dispatched.run, task: undefined },
  );
const trialEnded = (seq: number): VtcEvent =>
  variant(
    firstSample("headless.ended"),
    seq,
    { action_id: "a-90", outcome: "error", cause: "idle" },
    { run: dispatched.run, task: undefined },
  );

describe("withoutReplayTrials (reading 177)", () => {
  it("drops a marked dispatch, its submit and its headless run, keeping the run's own work", () => {
    const log = [...golden, trial(100), trialStarted(101), trialEnded(102), trialSubmitted(103)];
    const kept = withoutReplayTrials(log);
    expect(kept.map((e) => e.seq)).toEqual(golden.map((e) => e.seq));
    expect(kept).toContain(dispatched);
    expect(kept).toContain(submitted);
  });

  it("keeps a dispatch whose purpose is role or absent", () => {
    const own = variant(dispatched, 100, { action_id: "a-91", purpose: "role" });
    expect(withoutReplayTrials([own])).toEqual([own]);
  });

  it("returns the same log when there is no trial", () => {
    expect(withoutReplayTrials(golden)).toBe(golden);
  });
});

describe("createReplayTrialFilter (the live stream)", () => {
  it("hides a trial's events as they arrive, once its dispatch was seen", () => {
    const hidden = createReplayTrialFilter();
    expect(hidden(dispatched)).toBe(false);
    expect(hidden(trial(100))).toBe(true);
    expect(hidden(trialStarted(101))).toBe(true);
    expect(hidden(trialSubmitted(103))).toBe(true);
    expect(hidden(submitted)).toBe(false);
  });
});
