/**
 * The upstream-safe evidence snapshot (AD-27 rules 5 and 6; D-by, D-ce; spine §5 readings 208 and
 * 212(3)): what the evidence browser of a bs-vtc PR caused by a project run sees. It is never that
 * run's replay: the module builds the dashboard's own frozen read routes for a synthetic run
 * ({@link UPSTREAM_EVIDENCE_RUN}) from VTC-side data only (the `UpstreamReport`, the replay's
 * numbers with tasks as ordinals, the role's scorecards without their breakdown), and the
 * dashboard projects them again in `?evidence=upstream` mode. The routes are the ones the Lookback
 * view reads (`/api/health`, `/api/runs`, the run's events, the scorecard index, each scorecard,
 * the routing scorecard of D-cn and the replay result), keyed as the dashboard asks for them (`pathname?search`), so the
 * recorded page shows the scorecard and replay charts, not "No run selected".
 */
import {
  CONTRACTS_VERSION,
  ENGINE_HTTP,
  EVENT_PAGE_LIMIT,
  LOOKBACK_REPO,
  ReplayResultSchema,
  RoutingScorecardSchema,
  scorecardPath,
  ScorecardSchema,
  sha256Hex,
  type ReplayResult,
  type RoutingScorecard,
  type Scorecard,
  type UpstreamReport,
} from "@vtc/shared";

/** The synthetic run every upstream-safe evidence page shows (no project run id leaves). */
export const UPSTREAM_EVIDENCE_RUN = "vtc-upstream";

/** The proposal id the projected replay carries (the project's own id never leaves). */
export const UPSTREAM_EVIDENCE_PROPOSAL = "proposal";

/** Where the projected replay result is served. */
export const UPSTREAM_REPLAY_PATH = `${LOOKBACK_REPO.replaysDir}/${UPSTREAM_EVIDENCE_PROPOSAL}.json`;

/** The VTC-side data an upstream-safe page may show beyond the report. */
export interface UpstreamEvidenceData {
  /** A Lookback replay: projected to ordinals ({@link upstreamReplay}). */
  readonly replay?: ReplayResult;
  /** The role's scorecards (VTC-side numbers): projected without their breakdown. */
  readonly scorecards?: readonly Scorecard[];
  /**
   * The routing scorecard (D-cn, `LOOKBACK_REPO.routingScorecard`): VTC vocabulary and numbers
   * only (role, mode, host, size, risk class, tiers, metrics), checked against its strict schema.
   */
  readonly routingScorecard?: RoutingScorecard;
}

export interface UpstreamEvidenceSnapshot {
  readonly run: string;
  readonly routes: Readonly<Record<string, unknown>>;
  readonly events: readonly unknown[];
}

/**
 * Pure: a replay result with nothing of the project in it: its proposal id is
 * {@link UPSTREAM_EVIDENCE_PROPOSAL} and each task is `task-<n>`; the prompt SHAs, the grader
 * bundle and the numbers stay.
 */
export const upstreamReplay = (replay: ReplayResult): ReplayResult =>
  ReplayResultSchema.parse({
    ...replay,
    proposal: UPSTREAM_EVIDENCE_PROPOSAL,
    per_task: replay.per_task.map((t, i) => ({
      task: `task-${String(i + 1)}`,
      a: t.a,
      b: t.b,
      regression_set: t.regression_set,
    })),
  });

/** Pure: a scorecard without its discipline × stack breakdown (a stack pack is project text). */
export const upstreamScorecard = (card: Scorecard): Scorecard =>
  ScorecardSchema.parse({ ...card, breakdown: [] });

const path = (route: keyof typeof ENGINE_HTTP.routes, run = UPSTREAM_EVIDENCE_RUN): string =>
  ENGINE_HTTP.routes[route].path.replace(":run", encodeURIComponent(run));

/** The key the dashboard's `GET /api/runs/:run/artifacts?path=<rel>` arrives under. */
export const artifactRouteKey = (run: string, rel: string): string =>
  `${path("artifact", run)}?${new URLSearchParams({ path: rel }).toString()}`;

/** Pure: the `ArtifactContent` body of a JSON artifact of `run` (the dashboard's artifact route). */
export const jsonArtifact = (run: string, rel: string, value: unknown) => {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  return {
    run,
    path: rel,
    sha256: sha256Hex(content),
    size: new TextEncoder().encode(content).length,
    media_type: "application/json",
    encoding: "utf8" as const,
    content,
  };
};

/**
 * Pure: the frozen read routes and events of the synthetic run for an upstream-safe page. Without
 * a replay or scorecards the Lookback view has nothing to show, and the recorder's `waitFor`
 * fails the capture (no evidence of an empty page).
 */
export const upstreamEvidenceSnapshot = (input: {
  readonly report: UpstreamReport;
  readonly data?: UpstreamEvidenceData;
  readonly vtcVersion: string;
}): UpstreamEvidenceSnapshot => {
  const run = UPSTREAM_EVIDENCE_RUN;
  const { report } = input;
  const routes: Record<string, unknown> = {
    [path("health")]: {
      ok: true,
      mode: "live",
      engine_version: input.vtcVersion,
      contracts_version: CONTRACTS_VERSION,
      prototype_url: null,
    },
    [path("runs")]: {
      runs: [
        {
          id: run,
          track: "feature",
          phase: "retro",
          paused: false,
          started_at: report.first_seen,
          finished_at: report.last_seen,
        },
      ],
    },
  };
  const events: unknown[] = [];
  const replay = input.data?.replay;
  if (replay !== undefined) {
    const projected = jsonArtifact(run, UPSTREAM_REPLAY_PATH, upstreamReplay(replay));
    routes[artifactRouteKey(run, UPSTREAM_REPLAY_PATH)] = projected;
    events.push({
      v: 1,
      run,
      seq: 1,
      ts: replay.finished_at,
      type: "lookback.replay_finished",
      actor: "engine",
      data: {
        proposal: UPSTREAM_EVIDENCE_PROPOSAL,
        verdict: replay.verdict,
        path: UPSTREAM_REPLAY_PATH,
        sha256: projected.sha256,
      },
    });
  }
  const cards = (input.data?.scorecards ?? []).map(upstreamScorecard);
  if (cards.length > 0) {
    const index = {
      v: 1,
      scorecards: cards.map((c) => ({
        prompt: c.prompt,
        path: scorecardPath(c.prompt.role, c.prompt.host, c.prompt.effective_sha256),
        written_at: c.written_at,
      })),
    };
    routes[artifactRouteKey(run, LOOKBACK_REPO.scorecardIndex)] = jsonArtifact(
      run,
      LOOKBACK_REPO.scorecardIndex,
      index,
    );
    for (const [i, card] of cards.entries()) {
      const rel = index.scorecards[i]?.path ?? "";
      routes[artifactRouteKey(run, rel)] = jsonArtifact(run, rel, card);
    }
  }
  const routing = input.data?.routingScorecard;
  if (routing !== undefined) {
    const rel = LOOKBACK_REPO.routingScorecard;
    routes[artifactRouteKey(run, rel)] = jsonArtifact(
      run,
      rel,
      RoutingScorecardSchema.parse(routing),
    );
  }
  const page = { run, events, next_after: null };
  routes[path("runEvents")] = page;
  routes[`${path("runEvents")}?after=0&limit=${String(EVENT_PAGE_LIMIT.max)}`] = page;
  return { run, routes, events };
};
