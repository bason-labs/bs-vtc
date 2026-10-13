import { describe, expect, it } from "vitest";
import {
  EvidenceBundleSchema,
  TraceabilityReportSchema,
  type ArtifactContent,
  type EvidenceBundle,
} from "@vtc/shared";
import { bundleFacts, readEvidence, traceMatrix } from "@/lib/evidence";
import { readDevFixture } from "../fixtures";

const artifact = (path: string, content: string): ArtifactContent => ({
  run: "golden-1",
  path,
  sha256: "0".repeat(64),
  size: content.length,
  media_type: "application/json",
  encoding: "utf8",
  content,
});

const bundleText = (): string => readDevFixture(".vtc/evidence/T-1/bundle.json");
const bundle = (): EvidenceBundle => EvidenceBundleSchema.parse(JSON.parse(bundleText()));

describe("readEvidence (AD-18: bundles and traceability through the artifacts route)", () => {
  it("reads a task evidence bundle at evidenceBundlePath", () => {
    const doc = readEvidence(artifact(".vtc/evidence/T-1/bundle.json", bundleText()));
    expect(doc?.kind).toBe("bundle");
  });

  it("reads a traceability report", () => {
    const text = readDevFixture(".vtc/evidence/T-1/traceability.json");
    expect(readEvidence(artifact(".vtc/evidence/T-1/traceability.json", text))?.kind).toBe(
      "traceability",
    );
  });

  it("ignores other paths, invalid JSON and shapes that break the contract", () => {
    expect(readEvidence(artifact(".vtc/spec/spec.md", bundleText()))).toBeNull();
    expect(readEvidence(artifact(".vtc/evidence/T-1/bundle.json", "{"))).toBeNull();
    expect(readEvidence(artifact(".vtc/evidence/T-1/bundle.json", '{"kind":"task"}'))).toBeNull();
    expect(
      readEvidence({ ...artifact(".vtc/evidence/T-1/bundle.json", ""), encoding: "base64" }),
    ).toBeNull();
  });

  it("drops keys a newer minor engine added (tolerant reader)", () => {
    const text = JSON.stringify({ ...JSON.parse(bundleText()), added_later: 1 });
    expect(readEvidence(artifact(".vtc/evidence/T-1/bundle.json", text))?.kind).toBe("bundle");
  });
});

describe("traceMatrix (REQ → test → result)", () => {
  it("lists every requirement with its tests, results, hidden flag and provenance", () => {
    const m = traceMatrix(bundle().traceability);
    expect(m.rows.map((r) => [r.req, r.covered, r.tests.length])).toEqual([
      ["REQ-1", true, 1],
      ["REQ-1.AC-1", true, 2],
    ]);
    expect(m.rows[1]?.tests[1]).toMatchObject({
      id: "acceptance [REQ-1.AC-1] hash survives restart",
      status: { label: "Pass", tone: "ok" },
      hidden: true,
      provenance: "spec and observed",
    });
    expect(m.summary).toEqual({ reqs: 2, covered: 2, tests: 3, passing: 3, failing: 0 });
  });

  it("keeps gaps and scope creep, and shows an uncovered requirement with no tests", () => {
    const report = TraceabilityReportSchema.parse({
      run: "golden-1",
      task: "T-2",
      rows: [
        {
          req: "REQ-2.AC-1",
          tests: [{ id: "reset [REQ-2.AC-1] refuses expired", status: "fail" }],
          covered: false,
        },
        { req: "REQ-2", tests: [], covered: false },
      ],
      gaps: ["REQ-2", "REQ-2.AC-1"],
      scope_creep: ["src/other.ts"],
      built_at: "2026-10-13T09:35:00.000Z",
    });
    const m = traceMatrix(report);
    expect(m.rows.map((r) => r.req)).toEqual(["REQ-2", "REQ-2.AC-1"]);
    expect(m.rows[0]?.tests).toEqual([]);
    expect(m.rows[1]?.tests[0]?.status).toEqual({ label: "Fail", tone: "danger" });
    expect(m.rows[1]?.tests[0]?.provenance).toBe("unknown");
    expect(m.gaps).toEqual(["REQ-2", "REQ-2.AC-1"]);
    expect(m.scopeCreep).toEqual(["src/other.ts"]);
    expect(m.summary).toEqual({ reqs: 2, covered: 0, tests: 1, passing: 0, failing: 1 });
  });
});

describe("bundleFacts", () => {
  it("summarises a task bundle: rounds n/cap, findings, spend and verdicts", () => {
    const facts = bundleFacts(bundle());
    expect(facts.title).toBe("Task T-1 evidence");
    expect(facts.stats).toEqual([
      { label: "Discipline", value: "backend" },
      { label: "Rounds", value: "1/4" },
      { label: "Spend", value: "$1.20" },
      { label: "Tokens", value: "182,000 in · 24,100 out" },
      { label: "Findings", value: "0 open · 1 resolved" },
    ]);
    expect(facts.verdicts).toEqual([
      { role: "spec_verifier", subject: "REQ-1.AC-1", verdict: "pass", prompt: "666666666666" },
      { role: "qa", subject: "REQ-1", verdict: "pass", prompt: "777777777777" },
    ]);
    expect(facts.gateReports).toEqual([".vtc/evidence/T-1/round-1/junit.xml"]);
  });

  it("summarises a feature bundle with Final Review n/3, deferred items and per-task spend", () => {
    const b = bundle();
    const feature = EvidenceBundleSchema.parse({
      kind: "feature",
      run: "golden-1",
      feature: "F-1",
      tasks: [
        { task: "T-1", discipline: "backend", rounds: 1, spend: b.spend },
        { task: "T-2", discipline: "backend", rounds: 4, spend: { ...b.spend, usd: null } },
      ],
      by_discipline: [{ discipline: "backend", spend: b.spend }],
      traceability: { ...b.traceability, task: undefined, feature: "F-1" },
      findings: { open: 1, resolved: 2, deferred: 1, waived: 0, discarded: 0 },
      deferred: ["9".repeat(64)],
      final_review: { verdict: "fail", rounds: 2 },
      spend: { ...b.spend, usd: null },
      written_at: "2026-10-13T10:00:00.000Z",
    });
    const facts = bundleFacts(feature);
    expect(facts.title).toBe("Feature F-1 evidence");
    expect(facts.stats).toContainEqual({ label: "Final Review", value: "fail · round 2/3" });
    expect(facts.stats).toContainEqual({ label: "Spend", value: "unknown (model not priced)" });
    expect(facts.stats).toContainEqual({
      label: "Findings",
      value: "1 open · 2 resolved · 1 deferred",
    });
    expect(facts.tasks).toEqual([
      { task: "T-1", detail: "backend · 1 round · $1.20" },
      { task: "T-2", detail: "backend · 4 rounds · spend unknown" },
    ]);
    expect(facts.deferred).toEqual(["999999999999"]);
  });
});
