"use client";

import { ShieldQuestion } from "lucide-react";
import { useMemo } from "react";
import { runTopic } from "@/lib/api/topics";
import { headlessRuns } from "@/lib/headless";
import { pendingGate } from "@/lib/human-gates";
import { hrefs } from "@/lib/router";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { useRunEvents } from "@/lib/useRunEvents";
import { Link } from "@/components/app/Link";
import { Card, CardDescription, CardHeader, CardTitle, StatusPill } from "@/components/ui";

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${String(n)} ${n === 1 ? one : many}`;

/**
 * Above the run's graph: a gate waiting for the human (with what it asks), and the role runs
 * the engine launched itself (AD-25: a Codex Lead's roles, auto-resume), from the event log and
 * `StatusResult.headless_runs`. Shows nothing when there is neither.
 */
export function RunActivity({ run }: { run: string }) {
  const now = useNow();
  const events = useRunEvents(run, ["gates", "headless"]);
  const status = useResource("status", (c, s) => c.status(s), [runTopic(run, "status")]);
  const gate = useMemo(
    () => (events.data === undefined ? null : pendingGate(events.data.events)),
    [events.data],
  );
  const runs = useMemo(() => {
    if (events.data === undefined) return [];
    // `StatusResult` describes the active run only; without it, what is in flight is unknown.
    const inFlight = status.data?.run.id === run ? (status.data.headless_runs ?? null) : null;
    return headlessRuns(events.data.events, inFlight);
  }, [events.data, status.data, run]);
  return (
    <>
      {gate === null ? null : (
        <Card role="status" aria-label="Gate waiting" className="mb-4 border-accent/50">
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <ShieldQuestion aria-hidden className="size-4 text-accent-fg" />
            <span className="font-medium">
              {gate.gates} is waiting for approval in the Lead chat
            </span>
            <span className="text-muted-fg">
              {[
                gate.directions.length === 0
                  ? null
                  : plural(gate.directions.length, "design direction"),
                gate.facts.length === 0
                  ? null
                  : `${plural(gate.facts.length, "unverified fact")} to waive with a reason`,
                gate.coverage === null || gate.coverage.ok
                  ? null
                  : plural(gate.coverage.problems.length, "coverage gap"),
              ]
                .filter((x) => x !== null)
                .join(" · ")}
            </span>
            <Link className="ml-auto text-accent-fg underline" href={hrefs.gates(run)}>
              See what {gate.gates} shows
            </Link>
          </p>
        </Card>
      )}
      {runs.length === 0 ? null : (
        <Card aria-labelledby={`headless-${run}`} className="mb-4">
          <CardHeader>
            <div>
              <CardTitle id={`headless-${run}`}>Engine-launched role runs</CardTitle>
              <CardDescription>
                Headless runs the engine started itself, each with its own time limits.
              </CardDescription>
            </div>
          </CardHeader>
          <ul aria-label="Headless runs" className="space-y-2">
            {runs.map((r) => (
              <li
                key={r.actionId}
                className="rounded-2xl border border-border bg-surface/60 px-3 py-2 text-sm"
                data-testid={`headless-${r.actionId}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusPill meta={r.status} />
                  <span className="font-medium">
                    {r.role} on {r.host}
                  </span>
                  {r.task === null ? null : (
                    <Link className="underline" href={hrefs.task(run, r.task)}>
                      {r.task}
                    </Link>
                  )}
                  <time className="ml-auto text-xs text-muted-fg" dateTime={r.startedAt}>
                    {formatLocalTime(r.startedAt, now)}
                  </time>
                </div>
                <p className="mt-0.5 text-xs text-muted-fg">
                  <span className="font-mono">{r.actionId}</span> · {r.detail}
                </p>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
