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
  GateReportSchema,
  isEventOfType,
  parseEventLog,
  readEventData,
  ReplayResultSchema,
  sha256Hex,
  UsageReportSchema,
} from "@vtc/shared";
import { loadRuns } from "../../src/core/index.js";

const samples = new URL("../../../../fixtures/golden-run/samples/", import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, samples), "utf8");
const log = parseEventLog(read("wave3-events.jsonl"));

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
    const text = read("replay-p-spec-verifier-1.json");
    expect(readEventData(finished).sha256).toBe(sha256Hex(text));
    const result = ReplayResultSchema.parse(JSON.parse(text));
    expect(result.proposal).toBe(readEventData(finished).proposal);
    expect(result.verdict).toBe(readEventData(finished).verdict);
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
