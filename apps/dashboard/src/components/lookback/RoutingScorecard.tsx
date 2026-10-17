"use client";

import { LOOKBACK_LIMITS, LOOKBACK_REPO, type RoutingScorecard } from "@vtc/shared";
import { FileText } from "lucide-react";
import { useMemo } from "react";
import { runTopic } from "@/lib/api/topics";
import { describeError, isNotFound } from "@/lib/api/errors";
import { cn } from "@/lib/cn";
import { hrefs } from "@/lib/router";
import {
  readRoutingScorecard,
  routingScorecardView,
  type RoutingCellView,
  type RoutingGroupView,
  type RoutingMetric,
} from "@/lib/routing-scorecard";
import { useResource } from "@/lib/useResource";
import { Link } from "@/components/app/Link";
import { Card, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui";

const th = "px-3 py-2 font-medium";
const td = "border-t border-border px-3 py-2 align-top";

/** A proportion and its 95% interval on a 0–100% track (decorative; the text carries the data). */
function IntervalMark({ mark }: { mark: NonNullable<RoutingMetric["mark"]> }) {
  const pct = (x: number): string => `${String(Math.min(100, Math.max(0, x * 100)))}%`;
  return (
    <span aria-hidden className="relative mt-1 block h-2 w-24 rounded-full bg-surface-2">
      <span
        className="absolute inset-y-0 rounded-full bg-accent/30"
        style={{ left: pct(mark.low), width: pct(mark.high - mark.low) }}
      />
      <span
        className="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent ring-2 ring-surface"
        style={{ left: pct(mark.value) }}
      />
    </span>
  );
}

function MetricCell({ metric }: { metric: RoutingMetric | null }) {
  if (metric === null) return <td className={cn(td, "text-muted-fg")}>—</td>;
  return (
    <td className={cn(td, "tabular")}>
      <span className={cn(metric.insufficient && "text-muted-fg italic")}>{metric.value}</span>
      {metric.interval === null ? null : (
        <span className="block text-muted-fg">{metric.interval}</span>
      )}
      {metric.mark === null ? null : <IntervalMark mark={metric.mark} />}
    </td>
  );
}

const COLUMNS = [
  "Gates pass in round 1",
  "Review passes",
  "Tokens per success",
  "Escalated",
  "Cost per task",
] as const;

function CellRow({ cell }: { cell: RoutingCellView }) {
  return (
    <tr data-testid={`routing-cell-${cell.key}`}>
      <th scope="row" className={cn(td, "font-medium")}>
        {cell.size} · {cell.risk}
        <span className="block font-normal text-muted-fg">
          starts {cell.tier} · {cell.start}
        </span>
        <span className="block font-normal text-muted-fg tabular">{cell.tasks}</span>
        {cell.read ? null : (
          <span className="block font-normal text-muted-fg italic">
            not read yet: fewer than {LOOKBACK_LIMITS.routingMinTasks} tasks
          </span>
        )}
      </th>
      <MetricCell metric={cell.gatePass} />
      <MetricCell metric={cell.reviewPass} />
      <MetricCell metric={cell.tokensPerSuccess} />
      <MetricCell metric={cell.escalated} />
      <MetricCell metric={cell.costPerTask} />
    </tr>
  );
}

function GroupTable({ group }: { group: RoutingGroupView }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold">{group.title}</h4>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table
          aria-label={`Routing cells of ${group.title}`}
          className="w-full min-w-[44rem] table-fixed text-left text-xs"
        >
          <thead className="bg-surface-2 text-muted-fg">
            <tr>
              {/* fixed layout: every group's columns line up, so tiers compare across tables */}
              <th scope="col" className={cn(th, "w-[24%]")}>
                Size, risk and start tier
              </th>
              {COLUMNS.map((c) => (
                <th key={c} scope="col" className={th}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {group.cells.map((c) => (
              <CellRow key={c.key} cell={c} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The routing scorecard (D-cn; spine §5 reading 219): per (role, mode, host) a table of its cells
 * (size, risk class, start tier) with both pass rates and their 95% intervals drawn on a 0–100%
 * track, tokens per success, the escalated share and the cost per task. `data-testid=
 * "routing-scorecard"` is the evidence recorder's ready marker for routing PRs' chart shots.
 */
export function RoutingScorecardDetail({ scorecard }: { scorecard: RoutingScorecard }) {
  const view = useMemo(() => routingScorecardView(scorecard), [scorecard]);
  return (
    <div className="space-y-3" data-testid="routing-scorecard">
      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        {[
          ["Grader bundle", view.grader],
          [
            "Window",
            `${new Date(view.window.from).toLocaleDateString()} – ${new Date(view.window.to).toLocaleDateString()}`,
          ],
          ["Cells", String(scorecard.cells.length)],
        ].map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl bg-surface-2 p-2">
            <dt className="text-[11px] text-muted-fg">{label}</dt>
            <dd className="truncate font-mono font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      {view.groups.length === 0 ? (
        <p className="text-xs text-muted-fg">No cells recorded.</p>
      ) : (
        view.groups.map((g) => <GroupTable key={g.key} group={g} />)
      )}
    </div>
  );
}

/**
 * The Lookback view's routing card: reads `LOOKBACK_REPO.routingScorecard`. Upstream evidence
 * mode shows no path or link, and nothing at all while RETRO has not written one.
 */
export function RoutingScorecardCard({ run, upstream }: { run: string; upstream: boolean }) {
  const path = LOOKBACK_REPO.routingScorecard;
  const file = useResource(`artifact:${run}:${path}`, (c, s) => c.artifact(run, path, s), [
    runTopic(run, "lookback"),
  ]);
  const read = file.data === undefined ? null : readRoutingScorecard(file.data);
  const missing = file.data === undefined && isNotFound(file.error);
  if (missing && upstream) return null;
  if (missing) {
    return (
      <EmptyState
        title="No routing scorecard yet"
        description="RETRO scores each start tier by task size and risk once tasks have run with a recorded tier."
      />
    );
  }
  return (
    <Card aria-labelledby="routing-scorecard-title">
      <CardHeader>
        <div>
          <CardTitle id="routing-scorecard-title">Start tier by task difficulty</CardTitle>
          <CardDescription>
            Quality per token for each role, task size, risk and start tier. Lookback proposes a
            routing change when a cheaper start tier passes within{" "}
            {LOOKBACK_LIMITS.routingQualityMarginPct} points, or when{" "}
            {LOOKBACK_LIMITS.routingEscalationPct}% or more of a start tier&apos;s tasks escalate; a
            human merges the pull request.
          </CardDescription>
        </div>
        {upstream ? null : (
          <Link
            className="inline-flex items-center gap-1 text-xs text-accent-fg underline"
            href={hrefs.artifact(run, path)}
          >
            <FileText aria-hidden className="size-3.5" /> routing.json
          </Link>
        )}
      </CardHeader>
      {file.error !== null && file.data === undefined ? (
        <p className="text-sm text-danger">{describeError(file.error)}</p>
      ) : read === null ? (
        <p className="text-sm text-muted-fg" role="status">
          Loading…
        </p>
      ) : read.ok ? (
        <RoutingScorecardDetail scorecard={read.value} />
      ) : (
        <p className="text-sm text-danger">
          The routing scorecard breaks its contract and is not shown: {read.problem}
        </p>
      )}
    </Card>
  );
}
