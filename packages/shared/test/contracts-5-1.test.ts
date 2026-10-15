import { describe, expect, it } from "vitest";
import {
  AUTO_COMMENT_MARKER,
  CONTRACTS_VERSION,
  EVIDENCE_MODE_PARAM,
  EVIDENCE_MODE_VALUES,
  LOOKBACK_HOME,
  PACK_INPUT_TYPES,
  parsePersisted,
  QUIET_CLOSE_MARKER,
  REPO_ROLE_DENIED,
  renderTaskPack,
  ReplayInfraRowSchema,
  ReplayTrialRowSchema,
  ROLE_DENIED_VTC,
  ROLES_CHANGELOG_ANCHOR,
  TaskPackSchema,
} from "../src/index.js";

const SHA = "a".repeat(64);
const identity = {
  v: 1,
  repo_key: "0123456789abcdef",
  proposal: "p-engineer-1",
  baseline: SHA,
  candidate: "b".repeat(64),
  task: "R-1:T-2",
  arm: "b",
  trial: 2,
  grader_bundle_sha: "c".repeat(64),
} as const;

describe("contracts 5.1.0", () => {
  it("is MINOR over 5.0.0", () => {
    expect(CONTRACTS_VERSION).toBe("5.1.0");
  });
});

describe("the replay trial ledger (D-cg, reading 201)", () => {
  it("lives under the VTC home's lookback/, which no role may write", () => {
    expect(LOOKBACK_HOME.replayTrialsFile).toBe("lookback/replay-trials.jsonl");
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain("lookback/**");
  });
  it("keeps a graded trial and an unmeasured one apart, and reads newer fields leniently", () => {
    const graded = {
      ...identity,
      passed: true,
      tokens: 1200,
      read_denied: true,
      graded_at: "2026-10-15T08:00:00.000Z",
    };
    expect(ReplayTrialRowSchema.parse(graded)).toEqual(graded);
    expect(ReplayTrialRowSchema.safeParse({ ...graded, passed: undefined }).success).toBe(false);
    const infra = { ...identity, outcome: "plugin_locked", at: "2026-10-15T08:00:00.000Z" };
    expect(ReplayInfraRowSchema.parse(infra)).toEqual(infra);
    expect(ReplayInfraRowSchema.safeParse({ ...infra, outcome: "flaky" }).success).toBe(false);
    const read = parsePersisted(ReplayTrialRowSchema, { ...graded, later_field: 1 });
    expect(read.success).toBe(true);
  });
  it("takes a verdict replay's per-criterion task key", () => {
    const key = "R-1:AC-3:pass:T-2";
    expect(
      ReplayInfraRowSchema.safeParse({
        ...identity,
        task: key,
        outcome: "no_outcome",
        at: "2026-10-15T08:00:00.000Z",
      }).success,
    ).toBe(true);
  });
});

describe("post-G2 Dispatch lines (reading 179 as amended)", () => {
  const base = { v: 1, run: "R-3", action_id: "a-9", role: "visual_qa" } as const;
  it("prints the chosen direction", () => {
    expect(renderTaskPack({ ...base, design_direction: "quiet-ledger" })).toContain(
      "design direction: quiet-ledger",
    );
  });
  it("names the category_standard exit, and only that exit", () => {
    const text = renderTaskPack({ ...base, design_exit: "category_standard" });
    expect(text).toContain("design exit: category_standard");
    expect(text).not.toContain("design direction:");
    expect(TaskPackSchema.safeParse({ ...base, design_exit: "re_roll" }).success).toBe(false);
  });
  it("prints neither line on a pack that has neither", () => {
    const text = renderTaskPack(base);
    expect(text).not.toMatch(/design (direction|exit):/);
  });
});

describe("automation contracts (AD-27)", () => {
  it("an automatic run's issue is a pack input of its own (reading 198)", () => {
    expect(PACK_INPUT_TYPES.automationIssue).toBe("automation_issue");
  });
  it("the quiet-close marker differs from every other VTC comment's", () => {
    expect(QUIET_CLOSE_MARKER).toMatch(/^<!-- vtc:[a-z-]+ -->$/);
    expect(QUIET_CLOSE_MARKER).not.toBe(AUTO_COMMENT_MARKER);
  });
  it("the CHANGELOG anchor is one hidden HTML comment line", () => {
    expect(ROLES_CHANGELOG_ANCHOR).toBe("<!-- vtc:changelog-entries -->");
  });
  it("names the evidence mode query the recorder and the dashboard share", () => {
    expect(
      new URLSearchParams(`${EVIDENCE_MODE_PARAM}=${EVIDENCE_MODE_VALUES.upstream}`).get(
        "evidence",
      ),
    ).toBe("upstream");
    expect(EVIDENCE_MODE_VALUES.full).toBe("1");
  });
  it("no role writes a project's automatic-PR evidence manifests", () => {
    expect(REPO_ROLE_DENIED.writeDeny).toContain(".vtc/evidence/auto/**");
  });
});
