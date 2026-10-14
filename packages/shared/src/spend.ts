/**
 * Cost per client (spec §14 "Cost per feature and per client"; spine §5 reading 153). New in
 * 4.9.0. A run's spend lives in its own repo's event log; a client's projects are separate repos,
 * so the engine keeps one append-only record per client scope under the VTC home, written at
 * `run.finished`:
 * `~/.vtc/engines/spend/<scope>.jsonl` ({@link clientSpendPath}), one {@link ClientSpendRow} per
 * finished run. The scope is the research cache's (`researchScopeFor(project.yaml client)`:
 * `_shared` or `client-<slug>`), so a project reads only its own client's record (§14: context
 * never crosses clients). The record sits under `engines/`, which no role may write
 * (`ROLE_DENIED_VTC.homeWriteDeny`), so a role cannot rewrite what a client was charged. Flow
 * Studio reads the project's scope as a {@link ClientSpendReport} (`GET /api/spend`).
 */
import { z } from "zod";
import { RepoKeySchema } from "./lookback.js";
import { FeatureIdSchema, IsoDateTimeSchema, RunIdSchema, SlugSchema } from "./primitives.js";
import { ResearchScopeSchema, type ResearchScope } from "./research.js";

/** Where the client spend records live, relative to the VTC home. */
export const CLIENT_SPEND_DIR = "engines/spend";

/** `engines/spend/<scope>.jsonl`, relative to the VTC home. */
export const clientSpendPath = (scope: ResearchScope): string =>
  `${CLIENT_SPEND_DIR}/${ResearchScopeSchema.parse(scope)}.jsonl`;

/** USD with at most 4 decimals (the price table's rounding). */
const UsdSchema = z.number().nonnegative().max(1_000_000);

/** One finished run's spend, as the engine recorded it at `run.finished`. */
export const ClientSpendRowSchema = z.strictObject({
  v: z.literal(1),
  scope: ResearchScopeSchema,
  /** `project.yaml` `client`; `null` for the shared scope. */
  client: SlugSchema.nullable(),
  repo_key: RepoKeySchema,
  /** The repo's directory name, for display. */
  project: z.string().min(1).max(200),
  run: RunIdSchema,
  outcome: z.enum(["done", "aborted"]),
  finished_at: IsoDateTimeSchema,
  /** Every priced role run of the run, the front half's included (§11). */
  spent_usd: UsdSchema,
  /** Role runs with no cost (no host cost and no price): their spend is not in `spent_usd`. */
  unpriced_runs: z.int().nonnegative(),
  features: z
    .array(
      z.strictObject({
        feature: FeatureIdSchema,
        title: z.string().min(1).max(200),
        spent_usd: UsdSchema,
      }),
    )
    .max(50)
    .default([]),
});
export type ClientSpendRow = z.infer<typeof ClientSpendRowSchema>;
export type ClientSpendRowInput = z.input<typeof ClientSpendRowSchema>;

/** Most runs a report lists (the newest); the totals count every run. */
export const CLIENT_SPEND_REPORT_RUNS = 100;

/** `GET /api/spend`: the project's client scope, totalled per project. */
export const ClientSpendReportSchema = z.strictObject({
  scope: ResearchScopeSchema,
  client: SlugSchema.nullable(),
  total_usd: UsdSchema,
  unpriced_runs: z.int().nonnegative(),
  projects: z.array(
    z.strictObject({
      repo_key: RepoKeySchema,
      project: z.string().min(1).max(200),
      runs: z.int().nonnegative(),
      spent_usd: UsdSchema,
      last_finished_at: IsoDateTimeSchema,
    }),
  ),
  /** The newest {@link CLIENT_SPEND_REPORT_RUNS} runs, newest first. */
  runs: z.array(ClientSpendRowSchema).max(CLIENT_SPEND_REPORT_RUNS),
});
export type ClientSpendReport = z.infer<typeof ClientSpendReportSchema>;

/**
 * Pure: the report of a scope from its rows. A run recorded twice (a restart that finished it
 * again) counts once, by its repo and run id, keeping the newest row.
 */
export const clientSpendReport = (
  scope: ResearchScope,
  client: string | null,
  rows: readonly ClientSpendRow[],
): ClientSpendReport => {
  const byRun = new Map<string, ClientSpendRow>();
  for (const row of rows) {
    if (row.scope !== scope) continue;
    const key = `${row.repo_key}:${row.run}`;
    const seen = byRun.get(key);
    if (seen === undefined || row.finished_at >= seen.finished_at) byRun.set(key, row);
  }
  const runs = [...byRun.values()].sort((a, b) => b.finished_at.localeCompare(a.finished_at));
  const round = (usd: number): number => Math.round(usd * 10_000) / 10_000;
  const projects = new Map<string, ClientSpendReport["projects"][number]>();
  for (const row of [...runs].reverse()) {
    const p = projects.get(row.repo_key);
    projects.set(row.repo_key, {
      repo_key: row.repo_key,
      project: row.project,
      runs: (p?.runs ?? 0) + 1,
      spent_usd: round((p?.spent_usd ?? 0) + row.spent_usd),
      last_finished_at: row.finished_at,
    });
  }
  return ClientSpendReportSchema.parse({
    scope,
    client: client === null ? null : SlugSchema.parse(client),
    total_usd: round(runs.reduce((sum, r) => sum + r.spent_usd, 0)),
    unpriced_runs: runs.reduce((sum, r) => sum + r.unpriced_runs, 0),
    projects: [...projects.values()].sort((a, b) => b.spent_usd - a.spent_usd),
    runs: runs.slice(0, CLIENT_SPEND_REPORT_RUNS),
  });
};
