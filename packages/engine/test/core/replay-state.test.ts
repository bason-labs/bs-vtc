/**
 * The replay state the engine keeps in its private directory (`<guard>/replays/`, spine §5
 * reading 182): it is read back as trusted after a restart, so every plan and trial row is
 * checked against its shape on read, and a row's work tree is used only when it is one the engine
 * made (`isReplayTree`), since engine git calls take it as `--work-tree` and removal deletes it.
 * A forged or damaged row is dropped, never half-read.
 */
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseReplayPlan, parseTrialRows } from "../../src/core/replay.js";
import { newReplayTree } from "../../src/git/index.js";

const trees: string[] = [];
afterEach(() => {
  for (const tree of trees.splice(0)) rmSync(tree, { recursive: true, force: true });
});

const SHA = "a".repeat(64);
const version = {
  role: "engineer",
  host: "claude-code",
  locked_sha256: SHA,
  editable_sha256: SHA,
  effective_sha256: SHA,
};
const trial = {
  arm: "a",
  trial: 1,
  task: "r-1:T-1",
  regressionSet: false,
  role: "engineer",
  host: "claude-code",
  prompt: { version, text: "Make the smallest change." },
  pack: {},
  base: "b".repeat(40),
};
const plan = {
  v: 1,
  replays: [{ proposal: "p-1", role: "engineer", host: "claude-code", trials: [trial] }],
};

describe("parseTrialRows", () => {
  it("keeps well-formed rows, in order", () => {
    const tree = newReplayTree();
    trees.push(tree);
    const rows = parseTrialRows(
      [
        { kind: "preparing", replay: 0, n: 0, action: "a-9", tree },
        { kind: "dispatched", replay: 0, n: 0, action: "a-9", tree },
        { kind: "graded", replay: 0, n: 0, passed: true, tokens: 1200 },
        { kind: "unmeasured", replay: 0, n: 1, reason: "infra_error" },
        { kind: "finished", replay: 0 },
        { kind: "deferred", reason: "the weekly window" },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n"),
    );
    expect(rows.map((r) => r.kind)).toEqual([
      "preparing",
      "dispatched",
      "graded",
      "unmeasured",
      "finished",
      "deferred",
    ]);
    expect(rows[1]).toMatchObject({ tree });
  });

  it("drops a row that breaks its shape: a forged grade cannot skew the verdict the human approves from", () => {
    const rows = parseTrialRows(
      [
        '{"kind":"graded","replay":0,"n":0,"passed":"yes","tokens":10}',
        '{"kind":"graded","replay":0,"n":0,"passed":true,"tokens":-5}',
        '{"kind":"graded","replay":-1,"n":0,"passed":true,"tokens":5}',
        '{"kind":"graded","replay":0,"n":0,"passed":true,"tokens":5,"extra":1}',
        '{"kind":"promoted","replay":0}',
        "not json",
        "[]",
        "null",
        "",
      ].join("\n"),
    );
    expect(rows).toEqual([]);
  });

  it("uses a row's work tree only when it is one the engine made for a trial", () => {
    for (const tree of ["/etc", join(tmpdir(), "not-a-replay"), "relative/vtc-replay-x", "/"]) {
      const [row] = parseTrialRows(
        JSON.stringify({ kind: "dispatched", replay: 0, n: 0, action: "a-1", tree }),
      );
      expect(row, tree).toMatchObject({ kind: "dispatched", action: "a-1", tree: "" });
    }
  });
});

describe("parseReplayPlan", () => {
  it("reads a plan the engine wrote", () => {
    expect(parseReplayPlan(JSON.stringify(plan))?.replays[0]?.trials[0]?.base).toBe(trial.base);
  });

  it("refuses a plan that breaks its shape", () => {
    for (const bad of [
      { ...plan, v: 2 },
      { v: 1, replays: [{ ...plan.replays[0], trials: [{ ...trial, arm: "c" }] }] },
      { v: 1, replays: [{ ...plan.replays[0], trials: [{ ...trial, base: "--upload-pack=x" }] }] },
      { v: 1, replays: [{ ...plan.replays[0], host: "other" }] },
      { v: 1 },
    ]) {
      expect(parseReplayPlan(JSON.stringify(bad)), JSON.stringify(bad)).toBeNull();
    }
    expect(parseReplayPlan("{")).toBeNull();
  });
});
