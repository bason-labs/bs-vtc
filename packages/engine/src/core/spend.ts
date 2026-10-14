/**
 * Cost per client (spec §14; spine §5 reading 153): at `run.finished` the engine appends the
 * run's spend to its client scope's record under the VTC home (`clientSpendPath`), and Flow
 * Studio reads the project's scope back as a `ClientSpendReport` (`GET /api/spend`). The record
 * is the engine's (under `engines/`, which no role may write), append-only, private (0600, never
 * through a symlink), and a line that does not parse is skipped.
 */
import { basename, dirname, join } from "node:path";
import {
  clientSpendPath,
  clientSpendReport,
  ClientSpendRowSchema,
  engineRepoKey,
  parsePersisted,
  researchScopeFor,
  type ClientSpendReport,
  type ClientSpendRow,
} from "@vtc/shared";
import { appendPrivateFile, ensurePrivateDir, readPrivateFile } from "./guard.js";
import type { RunState } from "./state.js";

/** The finished run's spend row (§11 spend of every role run; unpriced runs counted apart). */
export const clientSpendRow = (
  repoRoot: string,
  client: string | undefined,
  state: RunState,
): ClientSpendRow | null => {
  const finished = state.events.findLast((e) => e.type === "run.finished");
  if (finished === undefined) return null;
  const runs = [...state.roleRuns.values()];
  const spent = runs.reduce((total, r) => total + (r.costUsd ?? 0), 0);
  const outcome = (finished.data as { outcome?: string }).outcome === "done" ? "done" : "aborted";
  return ClientSpendRowSchema.parse({
    v: 1,
    scope: researchScopeFor(client),
    client: client ?? null,
    repo_key: engineRepoKey(repoRoot),
    project: (basename(repoRoot) || "repo").slice(0, 200),
    run: state.id,
    outcome,
    finished_at: finished.ts,
    spent_usd: Math.round(spent * 10_000) / 10_000,
    unpriced_runs: runs.filter((r) => r.status === "submitted" && r.costUsd === null).length,
    features: [...state.features.values()].slice(0, 50).map((f) => ({
      feature: f.id,
      title: f.title.slice(0, 200),
      spent_usd: Math.round(f.spent_usd * 10_000) / 10_000,
    })),
  });
};

/** Appends a finished run's row to its client scope's record. */
export const recordClientSpend = (vtcHome: string, row: ClientSpendRow): void => {
  const path = join(vtcHome, clientSpendPath(row.scope));
  ensurePrivateDir(dirname(path));
  appendPrivateFile(path, `${JSON.stringify(row)}\n`);
};

/** The client scope's report: every row of the project's scope, totalled per project. */
export const readClientSpend = (vtcHome: string, client: string | undefined): ClientSpendReport => {
  const scope = researchScopeFor(client);
  const text = readPrivateFile(join(vtcHome, clientSpendPath(scope))) ?? "";
  const rows: ClientSpendRow[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = parsePersisted(ClientSpendRowSchema, JSON.parse(line) as unknown);
      if (parsed.success) rows.push(parsed.data);
    } catch {
      // a torn line is skipped; the rest still counts
    }
  }
  return clientSpendReport(scope, client ?? null, rows);
};
