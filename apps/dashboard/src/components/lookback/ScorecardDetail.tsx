"use client";

import type { Scorecard } from "@vtc/shared";
import { useId, useMemo } from "react";
import { cn } from "@/lib/cn";
import { metricRows, type MetricRow } from "@/lib/scorecards";

const th = "px-3 py-2 font-medium";
const td = "border-t border-border px-3 py-2 align-top";

function MetricsTable({ rows, label }: { rows: readonly MetricRow[]; label: string }) {
  if (rows.length === 0) return <p className="text-xs text-muted-fg">No metrics recorded.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-border">
      <table aria-label={label} className="w-full min-w-[28rem] text-left text-xs">
        <thead className="bg-surface-2 text-muted-fg">
          <tr>
            <th scope="col" className={th}>
              Metric
            </th>
            <th scope="col" className={th}>
              Value
            </th>
            <th scope="col" className={th}>
              95% interval
            </th>
            <th scope="col" className={th}>
              n
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} data-testid={`metric-${r.id}`}>
              <th scope="row" className={cn(td, "font-medium")}>
                {r.label}
                <span className="block font-normal text-muted-fg">{r.better} is better</span>
              </th>
              <td className={cn(td, "tabular", r.insufficient && "text-muted-fg italic")}>
                {r.value}
              </td>
              <td className={cn(td, "tabular text-muted-fg")}>
                {r.interval === null ? "—" : r.interval.replace(/^95% CI /, "")}
              </td>
              <td className={cn(td, "tabular text-muted-fg")}>{r.n.replace(/^n = /, "")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * One scorecard (§13): the prompt version it scores, the grader bundle that scored it, its
 * window, every metric with n and (for proportions) its 95% Wilson interval, "insufficient data"
 * below the minimum n, and the Engineer breakdown by discipline × stack pack × host.
 */
export function ScorecardDetail({ scorecard }: { scorecard: Scorecard }) {
  const rows = useMemo(() => metricRows(scorecard.metrics), [scorecard.metrics]);
  const id = useId();
  const p = scorecard.prompt;
  return (
    <div className="space-y-3" data-testid="scorecard">
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        {[
          ["Prompt version", p.effective_sha256.slice(0, 12)],
          ["Editable section", p.editable_sha256.slice(0, 12)],
          ["Grader bundle", scorecard.grader_bundle_sha.slice(0, 12)],
          [
            "Window",
            `${new Date(scorecard.window.from).toLocaleDateString()} – ${new Date(scorecard.window.to).toLocaleDateString()}`,
          ],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl bg-surface-2 p-2">
            <dt className="text-[11px] text-muted-fg">{label}</dt>
            <dd className="truncate font-mono font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <MetricsTable rows={rows} label={`Metrics of ${p.role} on ${p.host}`} />
      {scorecard.breakdown.length === 0 ? null : (
        <section aria-labelledby={id} className="space-y-2">
          <h4 id={id} className="text-xs font-semibold">
            By discipline, stack pack and host
          </h4>
          {scorecard.breakdown.map((b) => {
            const name = [b.discipline, b.stack_pack, b.host]
              .filter((x) => x !== undefined)
              .join(" · ");
            return (
              <div key={name} className="space-y-1">
                <p className="text-xs font-medium">{name}</p>
                <MetricsTable rows={metricRows(b.metrics)} label={`Metrics for ${name}`} />
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}
