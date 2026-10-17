/**
 * The upstream-safe evidence snapshot (AD-27 rules 5 and 6; spine §5 reading 212(3)): a bs-vtc PR
 * caused by a project run records the dashboard's Lookback view of a synthetic run, served from
 * the dashboard's own frozen read routes built from VTC-side data only. Each route validates as
 * its contract, the loopback snapshot server answers the URLs the dashboard asks for, nothing of
 * the project is in it, and `fixtures/upstream-evidence/snapshot.json` (which the dashboard's own
 * test renders) is what the module builds.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactContentSchema,
  EventPageSchema,
  EVENT_PAGE_LIMIT,
  HealthResultSchema,
  LOOKBACK_REPO,
  ReplayResultSchema,
  RoutingScorecardSchema,
  RunListSchema,
  ScorecardIndexSchema,
  ScorecardSchema,
  type ReplayResult,
  type RoutingScorecard,
  type Scorecard,
} from "@vtc/shared";
import {
  artifactRouteKey,
  planEvidenceShots,
  projectUpstreamReport,
  startSnapshotServer,
  UPSTREAM_EVIDENCE_RUN,
  UPSTREAM_REPLAY_PATH,
  upstreamEvidenceSnapshot,
  type SnapshotServer,
} from "../../src/upstream/index.js";
import { fakeAssets } from "./fakes.js";

const REPLAY: ReplayResult = {
  v: 1,
  proposal: "payroll-export-steps",
  role: "engineer",
  host: "claude-code",
  baseline: "a".repeat(64),
  candidate: "b".repeat(64),
  grader_bundle_sha: "c".repeat(64),
  k: 3,
  per_task: [
    { task: "r-7:T-12", a: [false, false, true], b: [true, true, true], regression_set: false },
    { task: "r-7:T-15", a: [true, true, true], b: [true, true, true], regression_set: true },
  ],
  aa_flip_rate: 0.05,
  sign_test: { n_discordant: 3, wins_b: 3, p: 0.125 },
  tokens_delta_pct: -8,
  verdict: "improve",
  finished_at: "2026-10-15T10:00:00.000Z",
  isolation: "paths_only",
  grader: "gates",
};

const CARD: Scorecard = {
  v: 1,
  prompt: {
    role: "engineer",
    host: "claude-code",
    locked_sha256: "1".repeat(64),
    editable_sha256: "2".repeat(64),
    effective_sha256: "a".repeat(64),
  },
  grader_bundle_sha: "c".repeat(64),
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" },
  metrics: {
    first_round_gate_pass: { value: 0.6, ci_low: 0.4, ci_high: 0.77, n: 25 },
    tokens_per_success: { value: 41000, ci_low: null, ci_high: null, n: 15 },
  },
  breakdown: [
    { discipline: "backend", stack_pack: "globex-payments", host: "claude-code", metrics: {} },
  ],
  written_at: "2026-10-14T00:00:00.000Z",
};

const ROUTING: RoutingScorecard = {
  v: 1,
  grader_bundle_sha: "c".repeat(64),
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-14T00:00:00.000Z" },
  cells: [
    {
      role: "engineer",
      host: "claude-code",
      size: "S",
      risk: "none",
      start_tier: "low",
      start_reason: "rule",
      tasks: 12,
      metrics: { first_round_gate_pass: { value: 0.75, ci_low: 0.47, ci_high: 0.91, n: 12 } },
      escalated: { value: 0.58, ci_low: 0.32, ci_high: 0.81, n: 12 },
      cost_per_task_usd: { value: 0.42, ci_low: 0.3, ci_high: 0.55, n: 12 },
    },
  ],
  written_at: "2026-10-14T00:00:00.000Z",
};

const snapshot = () =>
  upstreamEvidenceSnapshot({
    report: projectUpstreamReport({
      kind: "lookback",
      fingerprint: "0123456789abcdef",
      vtcVersion: "0.4.0",
      role: "engineer",
      host: "claude-code",
      promptSha: "a".repeat(64),
      metrics: { "replay.k": 3 },
      occurrences: 1,
      firstSeen: "2026-10-15T10:00:00.000Z",
      lastSeen: "2026-10-15T10:00:00.000Z",
    }),
    data: { replay: REPLAY, scorecards: [CARD], routingScorecard: ROUTING },
    vtcVersion: "0.4.0",
  });

let server: SnapshotServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("the upstream-safe evidence snapshot (reading 212(3))", () => {
  it("serves the dashboard's own read routes of a synthetic run, each valid as its contract", async () => {
    const built = snapshot();
    server = await startSnapshotServer({
      assets: fakeAssets(),
      routes: built.routes,
      events: built.events,
      replayMs: 40,
      knownValues: [],
    });
    const get = async (path: string): Promise<unknown> => {
      const response = await fetch(new URL(path, server?.origin));
      expect(response.status, path).toBe(200);
      return response.json();
    };
    const run = UPSTREAM_EVIDENCE_RUN;
    expect(HealthResultSchema.parse(await get("/api/health")).ok).toBe(true);
    expect(RunListSchema.parse(await get("/api/runs")).runs.map((r) => r.id)).toEqual([run]);
    const page = EventPageSchema.parse(
      await get(`/api/runs/${run}/events?after=0&limit=${String(EVENT_PAGE_LIMIT.max)}`),
    );
    expect(page.events.map((e) => e.type)).toEqual(["lookback.replay_finished"]);
    expect(page.events[0]?.data).toMatchObject({ path: UPSTREAM_REPLAY_PATH, verdict: "improve" });
    // the artifact URLs exactly as the dashboard's routeUrl writes them
    const artifact = async (rel: string) =>
      ArtifactContentSchema.parse(
        await get(`/api/runs/${run}/artifacts?${new URLSearchParams({ path: rel }).toString()}`),
      );
    const replay = ReplayResultSchema.parse(
      JSON.parse((await artifact(UPSTREAM_REPLAY_PATH)).content),
    );
    expect(replay.per_task.map((t) => t.task)).toEqual(["task-1", "task-2"]);
    const index = ScorecardIndexSchema.parse(
      JSON.parse((await artifact(LOOKBACK_REPO.scorecardIndex)).content),
    );
    expect(index.scorecards).toHaveLength(1);
    const card = ScorecardSchema.parse(
      JSON.parse((await artifact(index.scorecards[0]?.path ?? "")).content),
    );
    expect(card.metrics.first_round_gate_pass?.value).toBe(0.6);
    // D-cn: the routing scorecard, for a routing-table PR's charts
    const routing = RoutingScorecardSchema.parse(
      JSON.parse((await artifact(LOOKBACK_REPO.routingScorecard)).content),
    );
    expect(routing.cells.map((c) => [c.role, c.size, c.risk, c.start_tier])).toEqual([
      ["engineer", "S", "none", "low"],
    ]);
    // the module's own route of round 4 is gone
    expect((await fetch(new URL("/api/evidence/upstream", server.origin))).status).toBe(404);
  });

  it("holds nothing of the project: no run, task or proposal id, no stack pack", () => {
    const text = JSON.stringify(snapshot());
    for (const leak of ["r-7", "T-12", "T-15", "payroll", "globex"])
      expect(text, leak).not.toContain(leak);
    expect(artifactRouteKey(UPSTREAM_EVIDENCE_RUN, UPSTREAM_REPLAY_PATH)).toBe(
      `/api/runs/${UPSTREAM_EVIDENCE_RUN}/artifacts?path=.vtc%2Flookback%2Freplays%2Fproposal.json`,
    );
  });

  it("is the fixture the dashboard's evidence test renders, with the pages the recorder opens", async () => {
    const built = snapshot();
    await expect(
      `${JSON.stringify(
        {
          run: built.run,
          pages: [
            ...new Set(
              planEvidenceShots({ upstreamSafe: true, change: "prompt" }).map((s) => s.path),
            ),
          ],
          waitFor: [
            ...new Set(
              planEvidenceShots({ upstreamSafe: true, change: "prompt" }).map((s) => s.waitFor),
            ),
          ],
          routes: built.routes,
          events: built.events,
        },
        null,
        2,
      )}\n`,
    ).toMatchFileSnapshot("../../../../fixtures/upstream-evidence/snapshot.json");
  });
});
