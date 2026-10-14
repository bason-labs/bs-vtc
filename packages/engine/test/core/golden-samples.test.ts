/**
 * The wave-3 samples of the golden-run fixture (`fixtures/golden-run/samples/`): event payloads
 * the dashboard and other consumers build against (G2 with directions, facts, the DESIGN check and
 * the exits; headless runs; the Level-3 preflight, checklist and auto-merge; Final Review steps;
 * facts with a host-reported source; Lookback through a replay with its SHA-256 and a canary
 * rollback; a `prompt_selection` incident), a gate report whose visual summary names its
 * toolchain, and a usage report with who pays per host. Each validates against its contract, and
 * the log replays through the engine's own loader.
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AutomationReportSchema,
  automationFor,
  FactRowSchema,
  GateReportSchema,
  isEventOfType,
  parseEventLog,
  readEventData,
  ReplayResultSchema,
  sha256Hex,
  UsageReportSchema,
} from "@vtc/shared";
import { automationReportView, loadRuns } from "../../src/core/index.js";

const samples = new URL("../../../../fixtures/golden-run/samples/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, samples), "utf8");
const log = parseEventLog(read("wave3-events.jsonl"));

/** Every sample log replays through the engine's own loader as one run. */
const replays = (file: string, run: string, events: number): void => {
  const repo = mkdtempSync(join(tmpdir(), "vtc-samples-"));
  try {
    const path = join(repo, `.vtc/runs/${run}/events.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    cpSync(new URL(file, samples), path);
    const runs = loadRuns(repo);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.invalidLines).toEqual([]);
    expect(runs[0]?.state.events).toHaveLength(events);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
};

describe("golden-run wave-3 samples", () => {
  it("is a clean log with seq 1..n and typed payloads", () => {
    expect(log.invalidLines).toEqual([]);
    expect(log.truncatedTail).toBe(false);
    expect(log.events.map((e) => e.seq)).toEqual(log.events.map((_e, i) => i + 1));
  });

  it("covers every wave-3 event the closing round names", () => {
    const types = new Set(log.events.map((e) => e.type));
    for (const type of [
      "gate.requested",
      "headless.preflight",
      "headless.started",
      "headless.ended",
      "merge.preflight",
      "feature.checklist",
      "feature.auto_merge_enabled",
      "feature.auto_merge_disabled",
      "final_review.step_finished",
      "fact.recorded",
      "fact.verified",
      "fact.waived",
      "lookback.dispatched",
      "lookback.proposal_recorded",
      "lookback.replay_finished",
      "lookback.canary_assigned",
      "lookback.canary_evaluated",
      "lookback.rolled_back",
      "lookback.escaped_defect",
      "incident.recorded",
    ])
      expect(types, type).toContain(type);
  });

  it("shows G2 with directions, facts, the DESIGN check and the exits", () => {
    const gate = log.events.find((e) => isEventOfType(e, "gate.requested"));
    if (gate === undefined || !isEventOfType(gate, "gate.requested")) throw new Error("no G2");
    const data = readEventData(gate);
    expect(data.directions?.map((d) => d.novelty)).toEqual(["novel", "too_similar"]);
    expect(data.facts).toHaveLength(1);
    expect(data.design_coverage?.ok).toBe(true);
    expect(data.design_exits).toEqual(["re_roll", "category_standard"]);
  });

  it("has a fact with a host-reported source, kept unverified (H-3)", () => {
    const rows = log.events.flatMap((e) =>
      isEventOfType(e, "fact.recorded") ? [readEventData(e).fact] : [],
    );
    expect(rows.filter((f) => f.reported_source !== undefined)).toHaveLength(1);
    expect(rows[0]?.status).toBe("unverified");
  });

  it("a replay_finished names the SHA-256 of the replay result's bytes", () => {
    const finished = log.events.find((e) => isEventOfType(e, "lookback.replay_finished"));
    if (finished === undefined || !isEventOfType(finished, "lookback.replay_finished"))
      throw new Error("no replay");
    const text = read("replay-p-engineer-1.json");
    expect(readEventData(finished).sha256).toBe(sha256Hex(text));
    const result = ReplayResultSchema.parse(JSON.parse(text));
    expect(result.proposal).toBe(readEventData(finished).proposal);
    expect(result.verdict).toBe(readEventData(finished).verdict);
    // a replay this engine can produce: a file-writing role on a Codex-led headless run (verdict
    // roles are not replayed yet, an open question on spine readings 166 and 176)
    expect([result.role, result.host]).toEqual(["engineer", "codex"]);
    const dispatched = log.events.find((e) => isEventOfType(e, "lookback.dispatched"));
    if (dispatched === undefined || !isEventOfType(dispatched, "lookback.dispatched"))
      throw new Error("no lookback dispatch");
    expect(readEventData(dispatched).target_role).toBe(result.role);
    expect(readEventData(dispatched).target_host).toBe(result.host);
  });

  it("a gate report's visual summary names its toolchain", () => {
    const report = GateReportSchema.parse(JSON.parse(read("gate-report-visual.json")));
    expect(report.visual?.toolchain).toBe("project");
  });

  it("a usage report carries who pays per host (D-bq)", () => {
    const usage = UsageReportSchema.parse(JSON.parse(read("usage-billing.json")));
    expect(usage.hosts.map((h) => [h.host, h.billing])).toEqual([
      ["claude-code", "subscription"],
      ["codex", "api_key"],
    ]);
  });

  it("replays through the engine's loader", () => {
    const repo = mkdtempSync(join(tmpdir(), "vtc-samples-"));
    try {
      const path = join(repo, ".vtc/runs/golden-wave3/events.jsonl");
      mkdirSync(dirname(path), { recursive: true });
      cpSync(new URL("wave3-events.jsonl", samples), path);
      const runs = loadRuns(repo);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.invalidLines).toEqual([]);
      expect(runs[0]?.state.events).toHaveLength(log.events.length);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

/**
 * The closing-round samples the dashboard asked for (closing `merge.followups`): a gate result whose
 * visual step names its toolchain and one whose visual step was skipped with its reason, a usage
 * report billed through a provider (D-ci) beside an API key, a Level-3 park offering
 * `finish_level_2` (D-bd), a G2 whose DESIGN check names `directions_problem` (D-bt), and a facts
 * row with a host-reported source (H-3).
 */
describe("golden-run closing-round samples", () => {
  const closing = parseEventLog(read("closing-events.jsonl"));

  it("is a clean log with seq 1..n and typed payloads, and replays through the engine's loader", () => {
    expect(closing.invalidLines).toEqual([]);
    expect(closing.events.map((e) => e.seq)).toEqual(closing.events.map((_e, i) => i + 1));
    replays("closing-events.jsonl", "golden-closing", closing.events.length);
  });

  it("has a gate.result whose visual step names its toolchain, and one skipped with its reason", () => {
    const visuals = closing.events.flatMap((e) =>
      isEventOfType(e, "gate.result") ? [readEventData(e).visual] : [],
    );
    expect(visuals.map((v) => [v?.status, v?.toolchain, v?.skipped_reason !== undefined])).toEqual([
      ["pass", "vtc", false],
      ["skipped", undefined, true],
    ]);
  });

  it("has a G2 whose DESIGN check names the directions problem", () => {
    const gate = closing.events.find((e) => isEventOfType(e, "gate.requested"));
    if (gate === undefined || !isEventOfType(gate, "gate.requested")) throw new Error("no G2");
    expect(readEventData(gate).design_coverage).toMatchObject({ ok: false });
    expect(readEventData(gate).design_coverage?.directions_problem).toBeDefined();
  });

  it("has a Level-3 park that offers finish_level_2", () => {
    const opened = closing.events.find((e) => isEventOfType(e, "escalation.opened"));
    if (opened === undefined || !isEventOfType(opened, "escalation.opened"))
      throw new Error("no escalation");
    expect(readEventData(opened).escalation.options.map((o) => o.effect)).toEqual([
      "retry",
      "finish_level_2",
    ]);
  });

  it("has a usage report billed through a provider and an API key (D-ci)", () => {
    const usage = UsageReportSchema.parse(JSON.parse(read("usage-billing-provider.json")));
    expect(usage.hosts.map((h) => [h.host, h.billing])).toEqual([
      ["claude-code", "provider"],
      ["codex", "api_key"],
    ]);
  });

  it("has a facts row with a host-reported source", () => {
    const rows = read("facts.jsonl")
      .trim()
      .split("\n")
      .map((l) => FactRowSchema.parse(JSON.parse(l)));
    expect(rows[0]?.reported_source?.via).toBe("host_search");
  });
});

/**
 * The automation samples (AD-27, D-ca; spine §5 reading 209(3)): a log with an automatic run's
 * marker and every `upstream.*` and `automation.skipped` event, and `automation.json`, the
 * `GET /api/automation` answer engine core's read model gives for it (the snapshot moves to
 * `api/automation.json` when the integrator drops `PENDING_GOLDEN` at the round's merge).
 */
describe("golden-run automation samples", () => {
  const auto = parseEventLog(read("automation-events.jsonl"));

  it("is a clean log that covers every automation event and the automatic-run marker", () => {
    expect(auto.invalidLines).toEqual([]);
    replays("automation-events.jsonl", "golden-auto", auto.events.length);
    const types = new Set(auto.events.map((e) => e.type));
    for (const type of [
      "upstream.issue_opened",
      "upstream.issue_updated",
      "upstream.issue_closed",
      "upstream.pr_opened",
      "upstream.pr_closed",
      "automation.skipped",
    ])
      expect(types, type).toContain(type);
    const started = auto.events.find((e) => isEventOfType(e, "run.started"));
    if (started === undefined || !isEventOfType(started, "run.started")) throw new Error("no run");
    expect(readEventData(started).automation?.issue).toBe(12);
  });

  it("automation.json is the read model's answer for the log", () => {
    const snapshot = AutomationReportSchema.parse(JSON.parse(read("automation.json")));
    const settings = automationFor(
      { upstream: { share: false } },
      {
        upstream: { repo: "bason-labs/bs-vtc", share: true },
        automation: { evidence_hosting: "branch" },
      },
      { githubRemote: true, ghLoggedIn: true, paused: false },
    );
    expect(automationReportView(auto.events, settings)).toEqual(snapshot);
  });
});
