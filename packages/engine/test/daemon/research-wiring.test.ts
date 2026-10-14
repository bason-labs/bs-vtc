/**
 * The research module wired into the engine by the daemon (AD-22, AD-13 rule 12; spine §5 reading
 * 120): the role-facing tools answer only while a role run that declares them is in flight, a
 * proposed fact records that role and its event lands in that run's log, and before G2 the
 * re-checked fact table replaces the statuses `facts.jsonl` records.
 */
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  factId,
  RESEARCH_CACHE,
  RESEARCH_FACTS_FILE,
  type FactRow,
  type LeadAction,
  type VtcEvent,
} from "@vtc/shared";
import type { Engine } from "../../src/core/index.js";
import { createFetchQuota } from "../../src/research/index.js";
import { wireResearch } from "../../src/daemon/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import { FixtureHttp, jsonResponse } from "../research/fixture-http.js";
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

  it("charges a run's role calls to one research quota (reading 138)", async () => {
    const url = (v: string): string => `https://registry.npmjs.org/react/${v}`;
    const http = new FixtureHttp({
      [`GET ${url("1.0.0")}`]: jsonResponse(url("1.0.0"), { license: "MIT" }),
      [`GET ${url("2.0.0")}`]: jsonResponse(url("2.0.0"), { license: "MIT" }),
    });
    const h = createHarness();
    const stop = wireResearch(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home, http },
      {
        quotaPerRun: 1,
      },
    );
    const tools = h.engine.roleTools();
    if (tools === null) throw new Error("the role tools are not wired");
    await toDesign(h);
    const fetch = (version: string) =>
      tools(
        "research_fetch",
        { request: { fetcher: "registry", registry: "npm", name: "react", version } },
        CLAUDE,
      ) as Promise<{ result: { status: string; detail?: string } }>;
    expect((await fetch("1.0.0")).result.status).toBe("ok");
    // each call builds its own service, and the run's quota still holds across them
    const over = await fetch("2.0.0");
    expect(over.result.status).toBe("blocked");
    expect(over.result.detail).toContain("quota");
    expect(http.count(`GET ${url("2.0.0")}`)).toBe(0);
    stop();
    await h.release();
  });

  it("drops a run's quota count at run.finished (reading 138)", () => {
    const quota = createFetchQuota(5);
    let listener: ((event: VtcEvent) => void) | undefined;
    const engine = {
      config: () => ({ client: undefined }),
      setRoleTools: () => undefined,
      setFactRefresher: () => undefined,
      roleCalling: () => undefined,
      secrets: () => [],
      recordModuleEvent: () => undefined,
      onEvent: (fn: (event: VtcEvent) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
    } as unknown as Engine;
    const stop = wireResearch(engine, { repoRoot: tempDir(), vtcHome: tempDir() }, { quota });
    expect(quota.forRun("R-1").take()).toBe(true);
    expect(quota.forRun("R-2").take()).toBe(true);
    listener?.({ type: "run.finished", run: "R-1" } as VtcEvent);
    expect(quota.used("R-1")).toBe(0);
    expect(quota.used("R-2")).toBe(1);
    stop();
    expect(listener).toBeUndefined();
  });

  it("prunes the research cache on a schedule: a blob nothing cites goes (reading 138)", async () => {
    const h = createHarness();
    const blobs = join(h.home, RESEARCH_CACHE.homeDir, "_shared", RESEARCH_CACHE.blobsDir);
    mkdirSync(blobs, { recursive: true });
    const orphan = join(blobs, "a".repeat(64));
    writeFileSync(orphan, "stale page");
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    utimesSync(orphan, old, old);
    const stop = wireResearch(
      h.engine,
      { repoRoot: h.repo, vtcHome: h.home },
      { pruneEveryMs: 20 },
    );
    await vi.waitFor(() => {
      expect(existsSync(orphan)).toBe(false);
    });
    stop();
    await h.release();
  });

  it("sends nothing through the keyed search fetcher without a search provider (H-3, reading 156)", async () => {
    const http = new FixtureHttp();
    const h = createHarness();
    const key = (id: string): string | undefined => (id === "search" ? "sk-test-123" : undefined);
    const stop = wireResearch(h.engine, {
      repoRoot: h.repo,
      vtcHome: h.home,
      http,
      researchApiKey: key,
    });
    await toDesign(h);
    const search = (query: string) => {
      const tools = h.engine.roleTools();
      if (tools === null) throw new Error("the role tools are not wired");
      return tools("research_fetch", { request: { fetcher: "search", query } }, CLAUDE) as Promise<{
        result: { status: string };
      }>;
    };
    expect((await search("reset tokens")).result.status).not.toBe("ok");
    expect(http.requests).toEqual([]);
    stop();
    // with the user's provider the key is handed to the fetcher
    const opted = wireResearch(h.engine, {
      repoRoot: h.repo,
      vtcHome: h.home,
      http,
      researchApiKey: key,
      researchSearchProvider: "tavily",
    });
    await search("password reset token expiry");
    expect(http.requests.map((r) => `${r.method} ${new URL(r.url).host}`)).toEqual([
      "POST api.tavily.com",
    ]);
    opted();
    await h.release();
  });
});
