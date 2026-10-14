import type { ClientSpendReport } from "@vtc/shared";

/**
 * Cost per client (spec §14; spine §5 reading 153): the project's client scope as the engine
 * recorded it at each run's end, totalled per project of that client. A client never sees another
 * client's projects (the engine reads only the project's own scope).
 */
export interface ClientSpendModel {
  readonly title: string;
  readonly total: string;
  /** Role runs with no cost: their spend is not in the totals. */
  readonly unpriced: string | null;
  readonly projects: readonly {
    readonly key: string;
    readonly name: string;
    readonly runs: string;
    readonly spent: string;
    readonly lastFinishedAt: string;
  }[];
}

const usd = (value: number): string => `$${value.toFixed(2)}`;

export const clientSpendModel = (report: ClientSpendReport): ClientSpendModel => ({
  title:
    report.client === null ? "Projects with no client (shared scope)" : `Client ${report.client}`,
  total: usd(report.total_usd),
  unpriced:
    report.unpriced_runs === 0
      ? null
      : `${String(report.unpriced_runs)} role run${report.unpriced_runs === 1 ? "" : "s"} reported no cost and had no price: not counted`,
  projects: report.projects.map((p) => ({
    key: p.repo_key,
    name: p.project,
    runs: `${String(p.runs)} run${p.runs === 1 ? "" : "s"}`,
    spent: usd(p.spent_usd),
    lastFinishedAt: p.last_finished_at,
  })),
});
