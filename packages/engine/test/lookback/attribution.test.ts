import { AttributionSchema, LOOKBACK_REPO } from "@vtc/shared";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendAttributions,
  attributeRun,
  buildTraces,
  readAttributions,
  tiebreakAttribution,
  traceRef,
  traceSplit,
  TREE_CONFIDENCE,
} from "../../src/lookback/index.js";
import { EFFECTIVE, EDITABLE_SHA, HOST, LOCKED_SHA, lockedShaFor, RunLog, tempDir } from "./log.js";

const now = new Date("2026-10-14T12:00:00.000Z");
const attribute = (log: RunLog) => attributeRun({ events: log.events, lockedShaFor, now });

describe("traces", () => {
  it("joins each dispatch with its end and names its prompt version", () => {
    const log = new RunLog();
    const built = log.dispatch("engineer", { task: "T-1", tokens: 5000 });
    const failed = log.dispatch("qa", { task: "T-1", end: "failed" });
    const old = log.dispatch("ba", { versioned: false });
    const traces = buildTraces(log.events, lockedShaFor);
    expect(traces.map((t) => [t.trace, t.end?.kind, t.end?.tokens])).toEqual([
      [built, "submitted", 5000],
      [failed, "failed", null],
      [old, "submitted", 1000],
    ]);
    expect(traces[0]?.prompt).toEqual({
      role: "engineer",
      host: HOST,
      locked_sha256: LOCKED_SHA,
      editable_sha256: EDITABLE_SHA,
      effective_sha256: EFFECTIVE,
    });
    // Before contracts 4.5.0 a dispatch named no editable section: no version, Lookback skips it.
    expect(traces[2]?.prompt).toBeUndefined();
  });
});

describe("the attribution tree (§13)", () => {
  it("blames the Engineer's dispatch for a failed round gate (test fails)", () => {
    const log = new RunLog();
    log.dispatch("qa", { task: "T-1" });
    const eng = log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", false);
    const { attributions } = attribute(log);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({
      trace: eng,
      outcome: "failure",
      blamed_role: "engineer",
      method: "tree",
      rule: "test_fails",
      confidence: TREE_CONFIDENCE.single,
      split: traceSplit({ run: "r1", trace: eng }),
      task: "T-1",
    });
    expect(() => AttributionSchema.parse(attributions[0])).not.toThrow();
  });

  it("blames QA first, Engineer second, when the tests pass but a reviewer finds the behaviour wrong", () => {
    const log = new RunLog();
    const qa = log.dispatch("qa", { task: "T-1" });
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", true);
    log.finding("T-1", "patch", { category: "correctness" });
    const { attributions } = attribute(log);
    expect(attributions[0]).toMatchObject({
      trace: qa,
      blamed_role: "qa",
      secondary_role: "engineer",
      rule: "test_passes_behaviour_wrong",
    });
  });

  it("blames the Engineer for a reviewer's patch finding when the gate failed, never ran, or it is not about behaviour", () => {
    const failed = new RunLog();
    failed.dispatch("qa", { task: "T-1" });
    const eng = failed.dispatch("engineer", { task: "T-1" });
    failed.gate("T-1", false);
    failed.finding("T-1", "patch", { category: "maintainability" });
    failed.finding("T-1", "patch", { category: "correctness" });
    expect(attribute(failed).attributions).toEqual([
      expect.objectContaining({
        trace: eng,
        blamed_role: "engineer",
        rule: "test_fails",
        confidence: TREE_CONFIDENCE.single,
      }),
    ]);

    const ungated = new RunLog();
    ungated.dispatch("qa", { task: "T-1" });
    const eng2 = ungated.dispatch("engineer", { task: "T-1" });
    ungated.finding("T-1", "patch", { category: "correctness" });
    expect(attribute(ungated).attributions[0]).toMatchObject({ trace: eng2, rule: "test_fails" });

    const style = new RunLog();
    style.dispatch("qa", { task: "T-1" });
    const eng3 = style.dispatch("engineer", { task: "T-1" });
    style.gate("T-1", true);
    for (const category of ["maintainability", "docs", "performance"])
      style.finding("T-1", "patch", { category });
    expect(attribute(style).attributions[0]).toMatchObject({ trace: eng3, rule: "test_fails" });
  });

  it("blames QA for a test_defect finding whatever its route", () => {
    const log = new RunLog();
    const qa = log.dispatch("qa", { task: "T-1" });
    log.dispatch("engineer", { task: "T-1" });
    log.finding("T-1", "patch", { kind: "test_defect", category: "test_integrity" });
    expect(attribute(log).attributions[0]).toMatchObject({
      trace: qa,
      rule: "test_passes_behaviour_wrong",
    });
  });

  it("maps findings onto the rules: spec_gap → BA, test_adequacy → QA, a tool's patch → Engineer", () => {
    const spec = new RunLog();
    const ba = spec.dispatch("ba");
    spec.dispatch("engineer", { task: "T-1" });
    spec.finding("T-1", "spec_gap");
    expect(attribute(spec).attributions[0]).toMatchObject({
      trace: ba,
      blamed_role: "ba",
      rule: "missing_req",
    });

    const tests = new RunLog();
    const qa = tests.dispatch("qa", { task: "T-1" });
    tests.finding("T-1", "bad_test", { category: "test_adequacy" });
    expect(attribute(tests).attributions[0]).toMatchObject({ trace: qa, rule: "req_without_test" });

    const lint = new RunLog();
    const eng = lint.dispatch("engineer", { task: "T-1" });
    lint.finding("T-1", "patch", { source: "tool" });
    expect(attribute(lint).attributions[0]).toMatchObject({ trace: eng, rule: "test_fails" });
  });

  it("credits the first failure upstream when several rules fire on one task", () => {
    const log = new RunLog();
    const ba = log.dispatch("ba");
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", false);
    log.finding("T-1", "spec_gap");
    const { attributions } = attribute(log);
    expect(attributions).toHaveLength(1);
    expect(attributions[0]).toMatchObject({
      trace: ba,
      rule: "missing_req",
      confidence: TREE_CONFIDENCE.contested,
    });
  });

  it("lets a human label override the tree, and `none` blame nobody", () => {
    const log = new RunLog();
    const qa = log.dispatch("qa", { task: "T-1" });
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", false);
    log.escalate("T-1", "qa");
    expect(attribute(log).attributions).toEqual([
      expect.objectContaining({ trace: qa, blamed_role: "qa", method: "human", confidence: 1 }),
    ]);

    const none = new RunLog();
    none.dispatch("engineer", { task: "T-1" });
    none.gate("T-1", false);
    none.escalate("T-1", "none");
    expect(attribute(none).attributions).toEqual([]);
  });

  it("treats a labelled escalation as a failure of its own, at task or run scope", () => {
    const task = new RunLog();
    const qa = task.dispatch("qa", { task: "T-1" });
    task.dispatch("engineer", { task: "T-1" });
    task.escalate("T-1", "qa", "spec_question");
    expect(attribute(task).attributions).toEqual([
      expect.objectContaining({ trace: qa, blamed_role: "qa", method: "human" }),
    ]);

    const run = new RunLog();
    const ba = run.dispatch("ba");
    run.escalate(null, "ba", "spec_question");
    expect(attribute(run).attributions).toEqual([
      expect.objectContaining({ trace: ba, blamed_role: "ba", method: "human" }),
    ]);
  });

  it("returns a cap park with no signal as inconclusive, for an AI tiebreak", () => {
    const log = new RunLog();
    const eng = log.dispatch("engineer", { task: "T-1" });
    log.status("T-1", "fixing", "parked", 4, "cap");
    const result = attribute(log);
    expect(result.attributions).toEqual([]);
    expect(result.inconclusive).toEqual([expect.objectContaining({ task: "T-1", rule: null })]);
    const trace = buildTraces(log.events, lockedShaFor)[0];
    if (trace === undefined) throw new Error("no trace");
    const tiebreak = tiebreakAttribution({
      trace,
      blamed: "unknown",
      confidence: 0.4,
      evidence: [],
      now,
    });
    expect(tiebreak).toMatchObject({ trace: eng, method: "ai_tiebreak", blamed_role: null });
  });

  it("attributes an escaped defect to QA, and skips dispatches with no prompt version", () => {
    const log = new RunLog();
    log.dispatch("qa", { task: "T-1", versioned: false });
    log.add({
      type: "lookback.escaped_defect",
      feature: "F-1",
      data: { merge_commit: "c".repeat(40), kind: "revert", tasks: ["T-1"] },
    });
    const result = attribute(log);
    expect(result.attributions).toEqual([]);
    expect(result.unversioned).toBe(1);
  });

  it("tells apart dispatches of different runs that share an action id", () => {
    const first = new RunLog("r1");
    first.dispatch("engineer", { task: "T-1", action: "a-1" });
    first.gate("T-1", false);
    const second = new RunLog("r2");
    second.dispatch("engineer", { task: "T-1", action: "a-1" });
    second.gate("T-1", false);
    const done = attribute(first).attributions;
    const next = attributeRun({
      events: second.events,
      lockedShaFor,
      now,
      already: new Set(done.map(traceRef)),
    });
    expect(next.attributions).toEqual([expect.objectContaining({ run: "r2", trace: "a-1" })]);
  });

  it("adds nothing for traces already attributed, and round-trips the JSONL file", async () => {
    const root = await tempDir("attr");
    const log = new RunLog();
    log.dispatch("engineer", { task: "T-1" });
    log.gate("T-1", false);
    const first = attribute(log).attributions;
    await appendAttributions(root, first);
    const again = attributeRun({
      events: log.events,
      lockedShaFor,
      now,
      already: new Set((await readAttributions(root)).map(traceRef)),
    });
    expect(again.attributions).toEqual([]);
    expect(await readAttributions(root)).toEqual(first);
    const text = await readFile(join(root, LOOKBACK_REPO.attributions), "utf8");
    expect(text.trim().split("\n")).toHaveLength(1);
  });
});
