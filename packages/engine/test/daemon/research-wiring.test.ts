/**
 * The research module wired into the engine by the daemon (AD-22, AD-13 rule 12; spine §5 reading
 * 120): the role-facing tools answer only while a role run that declares them is in flight, a
 * proposed fact records that role and its event lands in that run's log, and before G2 the
 * re-checked fact table replaces the statuses `facts.jsonl` records.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { factId, RESEARCH_FACTS_FILE, type FactRow, type LeadAction } from "@vtc/shared";
import { wireResearch } from "../../src/daemon/index.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  only,
  SPEC,
  submitResult,
  workdir,
  type Harness,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanupDirs);

type ApproveGate = Extract<LeadAction, { type: "approve_gate" }>;
const gateOf = (actions: readonly LeadAction[]): ApproveGate => {
  const gate = actions.find((a): a is ApproveGate => a.type === "approve_gate");
  if (gate === undefined) throw new Error(`expected a gate, got ${JSON.stringify(actions)}`);
  return gate;
};

const lines = (h: Harness): { type: string; data: Record<string, unknown> }[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown> });

/** A feature run through G1: the Architect (and Security) are then in flight. */
const toDesign = async (h: Harness): Promise<readonly LeadAction[]> => {
  await h.engine.start(
    {
      request: "Password reset",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
  const carto = only((await h.engine.next({}, CLAUDE)).actions, "repo_cartographer");
  writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
  const ba = only(
    (
      await submitResult(h, carto, {
        exit: "done",
        artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
      })
    ).actions,
    "ba",
  );
  writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC);
  const g1 = gateOf(
    (
      await submitResult(h, ba, {
        exit: "done",
        artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
      })
    ).actions,
  );
  return (
    await h.engine.approve(
      { gates: g1.gates, decision: "approve", frozen: g1.artifacts, waived_facts: [] },
      CLAUDE,
    )
  ).actions;
};

describe("the daemon wires the research module (reading 120)", () => {
  it("serves the role tools only to an in-flight role that declares them", async () => {
    const h = createHarness();
    wireResearch(h.engine, { repoRoot: h.repo, vtcHome: h.home });
    const tools = h.engine.roleTools();
    if (tools === null) throw new Error("the role tools are not wired");
    await expect(tools("fact_lookup", { subject: "nodejs@22" }, CLAUDE)).rejects.toMatchObject({
      code: "forbidden",
    });
    const design = await toDesign(h);
    expect(only(design, "architect").role).toBe("architect");
    await expect(tools("fact_lookup", { subject: "nodejs@22" }, CLAUDE)).resolves.toEqual({
      facts: [],
    });
    const proposed = (await tools(
      "fact_propose",
      { subject: "nodejs@22", predicate: "eol_date", value: "2027-04-30", source: null },
      CLAUDE,
    )) as { fact: FactRow };
    expect(proposed.fact).toMatchObject({ status: "unverified", recorded_by: "architect" });
    expect(readFileSync(join(h.repo, RESEARCH_FACTS_FILE), "utf8")).toContain(proposed.fact.id);
    expect(lines(h).filter((e) => e.type === "fact.recorded")).toHaveLength(1);
    await h.release();
  });

  it("G2 takes the fact table's statuses from the re-check, not from the file", async () => {
    // a row that claims `verified` with nothing in the research cache behind it
    const planted: FactRow = {
      v: 1,
      id: factId("pg@17", "eol_date", "2029-11-08", "https://endoflife.date/api/postgresql.json"),
      subject: "pg@17",
      predicate: "eol_date",
      value: "2029-11-08",
      status: "verified",
      source: {
        fetcher: "eol",
        url: "https://endoflife.date/api/postgresql.json",
        retrieved_at: "2026-10-13T08:00:00.000Z",
        content_sha256: "a".repeat(64),
        locator: { kind: "json_pointer", pointer: "/0/eol" },
      },
      recorded_by: "research_analyst",
      recorded_at: "2026-10-13T08:00:00.000Z",
    };
    const h = createHarness({ files: { [RESEARCH_FACTS_FILE]: `${JSON.stringify(planted)}\n` } });
    wireResearch(h.engine, { repoRoot: h.repo, vtcHome: h.home });
    const design = await toDesign(h);
    const architect = only(design, "architect");
    const security = only(design, "security");
    writeFile(workdir(architect), ".vtc/architecture/spine.md", "# Spine\n");
    await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
    });
    writeFile(workdir(security), ".vtc/architecture/threat-model/model.md", "# Threats\n");
    const gate = gateOf(
      (
        await submitResult(h, security, {
          exit: "done",
          artifacts: [{ type: "threat_model", path: ".vtc/architecture/threat-model/model.md" }],
        })
      ).actions,
    );
    expect(gate.gates).toContain("G2");
    expect(gate.unverified_facts).toContain(planted.id);
    await h.release();
  });
});
