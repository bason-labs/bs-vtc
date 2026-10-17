/**
 * Contracts 4.11.0 (the closing-round integration; spine §5 readings 177–181): replay trials
 * marked in the log, replay isolation, and the chosen G2 direction in post-G2 packs.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  DESIGN_CONTRACTS_DIR,
  DESIGN_SCREENS_PATH,
  designContractPath,
  EVENT_PAYLOAD_SCHEMAS,
  ReplayResultSchema,
  TaskPackSchema,
} from "../src/index.js";

const dispatched = EVENT_PAYLOAD_SCHEMAS["role.dispatched"];
const base = {
  action_id: "a-7",
  dispatch: "headless",
  agent: "vtc-engineer",
  pack: ".vtc/state/packs/a-7.md",
  resume: null,
} as const;
const trial = { proposal: "p-engineer-1", task: "R-3:T-1", arm: "b", trial: 2 } as const;

describe("contracts 4.11.0", () => {
  it("was MINOR over 4.10.0; its contracts stay in force in 5.0.0 (MAJOR for D-ck only)", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });
});

describe("replay trials in the log (reading 177)", () => {
  it("an older dispatch with no purpose still reads as the run's own work", () => {
    const parsed = dispatched.parse(base);
    expect(parsed.purpose).toBeUndefined();
    expect(parsed.replay).toBeUndefined();
    expect(dispatched.parse({ ...base, purpose: "role" }).purpose).toBe("role");
  });

  it("a lookback_replay dispatch names its trial, and only then", () => {
    expect(dispatched.parse({ ...base, purpose: "lookback_replay", replay: trial }).replay).toEqual(
      trial,
    );
    expect(dispatched.safeParse({ ...base, purpose: "lookback_replay" }).success).toBe(false);
    expect(dispatched.safeParse({ ...base, replay: trial }).success).toBe(false);
    expect(dispatched.safeParse({ ...base, purpose: "role", replay: trial }).success).toBe(false);
    expect(
      dispatched.safeParse({
        ...base,
        purpose: "lookback_replay",
        replay: { ...trial, arm: "c" },
      }).success,
    ).toBe(false);
    expect(
      dispatched.safeParse({
        ...base,
        purpose: "lookback_replay",
        replay: { ...trial, trial: 0 },
      }).success,
    ).toBe(false);
  });
});

describe("replay isolation (reading 178)", () => {
  const result = {
    v: 1,
    proposal: "p-engineer-1",
    role: "engineer",
    host: "codex",
    baseline: "a".repeat(64),
    candidate: "b".repeat(64),
    grader_bundle_sha: "c".repeat(64),
    k: 3,
    per_task: [{ task: "R-3:T-1", a: [true], b: [true], regression_set: true }],
    aa_flip_rate: 0,
    sign_test: { n_discordant: 0, wins_b: 0, p: 1 },
    tokens_delta_pct: 0,
    verdict: "no_change",
    finished_at: "2026-10-14T08:00:00.000Z",
  } as const;

  it("is optional on a ReplayResult, and only names a known level", () => {
    expect(ReplayResultSchema.parse(result).isolation).toBeUndefined();
    expect(ReplayResultSchema.parse({ ...result, isolation: "paths_only" }).isolation).toBe(
      "paths_only",
    );
    expect(ReplayResultSchema.safeParse({ ...result, isolation: "sealed" }).success).toBe(false);
  });
});

describe("the chosen G2 direction (reading 179)", () => {
  it("a post-G2 pack may name the approved direction", () => {
    const pack = TaskPackSchema.parse({
      v: 1,
      run: "R-3",
      action_id: "a-9",
      role: "visual_qa",
      design_direction: "quiet-ledger",
    });
    expect(pack.design_direction).toBe("quiet-ledger");
    expect(
      TaskPackSchema.safeParse({
        v: 1,
        run: "R-3",
        action_id: "a-9",
        role: "visual_qa",
        design_direction: "Not A Slug",
      }).success,
    ).toBe(false);
  });

  it("each key screen's design contract sits beside the screen list", () => {
    expect(DESIGN_CONTRACTS_DIR).toBe(DESIGN_SCREENS_PATH.replace(/\.yaml$/, ""));
    expect(designContractPath("login")).toBe(".vtc/design/screens/login.md");
    expect(() => designContractPath("../escape")).toThrow();
  });
});
