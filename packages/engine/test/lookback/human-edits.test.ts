import { LOOKBACK_LIMITS, sha256Hex, type Attribution } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  HUMAN_EDIT_DIFF_MAX_CHARS,
  humanEdits,
  lookbackAtRunEnd,
  lookbackTargets,
  LOOKBACK_MAX_HUMAN_EDITS,
  traceRef,
  traceSplit,
  type HumanEdit,
} from "../../src/lookback/index.js";
import { EDITABLE_SHA, EFFECTIVE, HOST, LOCKED_SHA, lockedShaFor, RunLog, tempDir } from "./log.js";

const now = new Date("2026-10-14T18:00:00.000Z");
const SPEC = ".vtc/spec/spec.md";
const ROLE_SHA = sha256Hex("the BA's spec");
const HUMAN_SHA = sha256Hex("the spec after the human's edit");

/** A role dispatch that submits `artifacts` (path → sha). */
const submitArtifacts = (log: RunLog, role: string, artifacts: Record<string, string>): string => {
  const action = log.dispatch(role, { end: "none" });
  log.add({
    type: "role.submitted",
    actor: "role",
    role,
    host: HOST,
    model: "claude-sonnet-5",
    prompt_sha: EFFECTIVE,
    tokens: { in: 900, out: 100, cache_r: 0, cache_w: 0 },
    cost_usd: 0.1,
    data: {
      action_id: action,
      exit: "done",
      findings: 0,
      questions: 0,
      session_ref: null,
      artifacts: Object.entries(artifacts).map(([path, sha256]) => ({
        type: "spec",
        path,
        sha256,
      })),
    },
  });
  return action;
};

const approve = (log: RunLog, frozen: Record<string, string>, actor = "human"): void => {
  log.add({
    type: "gate.approved",
    actor,
    data: {
      gates: ["G1"],
      frozen: Object.entries(frozen).map(([path, sha256]) => ({ path, sha256 })),
    },
  });
};

describe("human edits (spec §13 improvement loop step 1)", () => {
  it("finds an artifact a human changed between the role's submit and the gate's freeze", () => {
    const log = new RunLog("r1");
    const action = submitArtifacts(log, "ba", { [SPEC]: ROLE_SHA });
    approve(log, { [SPEC]: HUMAN_SHA });
    const edits = humanEdits(log.events, lockedShaFor);
    expect(edits).toEqual([
      expect.objectContaining({
        run: "r1",
        trace: action,
        id: `r1.${action}`,
        path: SPEC,
        role_sha256: ROLE_SHA,
        human_sha256: HUMAN_SHA,
        gates: ["G1"],
        split: traceSplit({ run: "r1", trace: action }),
      }),
    ]);
    expect(edits[0]?.prompt).toEqual({
      role: "ba",
      host: HOST,
      locked_sha256: LOCKED_SHA,
      editable_sha256: EDITABLE_SHA,
      effective_sha256: EFFECTIVE,
    });
  });

  it("finds nothing when the gate froze what the role wrote", () => {
    const log = new RunLog("r1");
    submitArtifacts(log, "ba", { [SPEC]: ROLE_SHA });
    approve(log, { [SPEC]: ROLE_SHA });
    expect(humanEdits(log.events, lockedShaFor)).toEqual([]);
  });

  it("credits the last role that wrote the file, so a role's rework is not a human edit", () => {
    const log = new RunLog("r1");
    submitArtifacts(log, "ba", { [SPEC]: ROLE_SHA });
    submitArtifacts(log, "ba", { [SPEC]: HUMAN_SHA });
    approve(log, { [SPEC]: HUMAN_SHA });
    expect(humanEdits(log.events, lockedShaFor)).toEqual([]);

    const edited = new RunLog("r1");
    submitArtifacts(edited, "ba", { [SPEC]: ROLE_SHA });
    const second = submitArtifacts(edited, "ba", { [SPEC]: sha256Hex("second draft") });
    approve(edited, { [SPEC]: HUMAN_SHA });
    expect(humanEdits(edited.events, lockedShaFor).map((e) => e.trace)).toEqual([second]);
  });

  it("ignores files no role wrote, approvals not made by a human, and other runs' submits", () => {
    const log = new RunLog("r1");
    submitArtifacts(log, "ba", { [SPEC]: ROLE_SHA });
    approve(log, { ".vtc/spec/other.md": HUMAN_SHA });
    approve(log, { [SPEC]: HUMAN_SHA }, "engine");
    expect(humanEdits(log.events, lockedShaFor)).toEqual([]);

    const first = new RunLog("r1");
    submitArtifacts(first, "ba", { [SPEC]: ROLE_SHA });
    const second = new RunLog("r2");
    approve(second, { [SPEC]: HUMAN_SHA });
    expect(humanEdits([...first.events, ...second.events], lockedShaFor)).toEqual([]);
  });

  it("skips a dispatch with no prompt version", () => {
    const log = new RunLog("r1");
    submitArtifacts(log, "ba", { [SPEC]: ROLE_SHA });
    approve(log, { [SPEC]: HUMAN_SHA });
    expect(humanEdits(log.events, () => undefined)).toEqual([]);
  });
});

const prompt = {
  role: "ba",
  host: HOST,
  locked_sha256: "1".repeat(64),
  editable_sha256: "2".repeat(64),
  effective_sha256: "3".repeat(64),
} as const;

const failure = (trace: string): Attribution => ({
  v: 1,
  trace,
  run: "r1",
  prompt,
  outcome: "failure",
  blamed_role: "ba",
  method: "tree",
  rule: "missing_req",
  confidence: 1,
  split: "train",
  evidence: [],
  attributed_at: now.toISOString(),
});

const edit = (trace: string, over: Partial<HumanEdit> = {}): HumanEdit => ({
  id: `r1.${trace}`,
  run: "r1",
  trace,
  seq: 1,
  prompt,
  split: traceSplit({ run: "r1", trace }),
  path: SPEC,
  role_sha256: ROLE_SHA,
  human_sha256: HUMAN_SHA,
  gates: ["G1"],
  ...over,
});

const trainIds = (prefix: string, count: number): string[] => {
  const ids: string[] = [];
  for (let i = 0; ids.length < count; i += 1) {
    const id = `${prefix}-${String(i)}`;
    if (traceSplit({ run: "r1", trace: id }) === "train") ids.push(id);
  }
  return ids;
};

const heldOutId = (prefix: string): string => {
  for (let i = 0; ; i += 1) {
    const id = `${prefix}-${String(i)}`;
    if (traceSplit({ run: "r1", trace: id }) === "holdout") return id;
  }
};

describe("lookback targets carry human edits", () => {
  const attributions = trainIds("f", LOOKBACK_LIMITS.minTrainFailures).map(failure);
  const fresh = new Set(attributions.map(traceRef));

  it("gives the lookback role the train-split edits of the version under review", () => {
    const [kept] = trainIds("e", 1);
    const other = trainIds("o", 1)[0] ?? "";
    const held = heldOutId("h");
    const { targets } = lookbackTargets({
      attributions,
      fresh,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      humanEdits: [
        edit(kept ?? ""),
        // another version, another role, a held-out trace: none of them is shown
        edit(other, { prompt: { ...prompt, effective_sha256: "4".repeat(64) } }),
        edit(other, { prompt: { ...prompt, role: "architect" } }),
        edit(held),
      ],
    });
    expect(targets).toHaveLength(1);
    expect(targets[0]?.human_edits).toEqual([
      {
        id: `r1.${kept ?? ""}`,
        run: "r1",
        trace: kept,
        path: SPEC,
        role_sha256: ROLE_SHA,
        human_sha256: HUMAN_SHA,
        gates: ["G1"],
      },
    ]);
  });

  it("keeps the newest edits only, and edits alone never dispatch the lookback role", () => {
    const ids = trainIds("e", LOOKBACK_MAX_HUMAN_EDITS + 3);
    const many = ids.map((id, i) => edit(id, { seq: i + 1 }));
    const { targets } = lookbackTargets({
      attributions,
      fresh,
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      humanEdits: many,
    });
    expect(targets[0]?.human_edits.map((e) => e.trace)).toEqual(
      ids.slice(-LOOKBACK_MAX_HUMAN_EDITS),
    );
    expect(
      lookbackTargets({
        attributions: [],
        fresh: new Set(),
        weeklyRemainingPct: 80,
        budgetAvailable: true,
        humanEdits: many,
      }).targets,
    ).toEqual([]);
  });
});

describe("lookback at run end reads human edit diffs", () => {
  /** An engineer run with enough train failures, plus a human edit of an engineer's artifact. */
  const run = (): { log: RunLog; edited: string } => {
    const log = new RunLog("r1");
    let edited = "";
    for (let i = 1; edited === "" || i <= LOOKBACK_LIMITS.minTrainFailures * 4; i += 1) {
      const task = `T-${String(i)}`;
      log.taskCreated(task, "backend", ["node"]);
      log.dispatch("engineer", { task, tokens: 2000 });
      log.gate(task, false);
      if (edited === "") {
        const action = submitArtifacts(log, "engineer", { [SPEC]: ROLE_SHA });
        if (traceSplit({ run: "r1", trace: action }) === "train") {
          approve(log, { [SPEC]: HUMAN_SHA });
          edited = action;
        }
      }
    }
    return { log, edited };
  };

  it("asks the injected reader for each edit's diff and caps it", async () => {
    const { log, edited } = run();
    const asked: HumanEdit[] = [];
    const result = await lookbackAtRunEnd({
      projectRoot: await tempDir("edits"),
      events: log.events,
      history: log.events,
      lockedShaFor,
      graderBundleSha: "f".repeat(64),
      weeklyRemainingPct: 80,
      budgetAvailable: true,
      now,
      humanEditDiff: (e) => {
        asked.push(e);
        return Promise.resolve(`-old\n+new\n${"x".repeat(HUMAN_EDIT_DIFF_MAX_CHARS)}`);
      },
    });
    expect(asked.map((e) => e.trace)).toEqual([edited]);
    const [target] = result.targets;
    expect(target?.human_edits).toHaveLength(1);
    const diff = target?.human_edits[0]?.diff ?? "";
    expect(diff.startsWith("-old\n+new\n")).toBe(true);
    expect(diff.length).toBeLessThanOrEqual(HUMAN_EDIT_DIFF_MAX_CHARS);
    expect(diff).toContain("[diff cut]");
  });

  it("keeps the edit without a diff when the reader fails or has none", async () => {
    const { log } = run();
    for (const reader of [
      () => Promise.reject(new Error("git failed")),
      () => Promise.resolve(undefined),
    ]) {
      const result = await lookbackAtRunEnd({
        projectRoot: await tempDir("edits"),
        events: log.events,
        history: log.events,
        lockedShaFor,
        graderBundleSha: "f".repeat(64),
        weeklyRemainingPct: 80,
        budgetAvailable: true,
        now,
        humanEditDiff: reader,
      });
      expect(result.targets[0]?.human_edits).toHaveLength(1);
      expect(result.targets[0]?.human_edits[0]).not.toHaveProperty("diff");
    }
  });
});
