"use client";

import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { runTopic } from "@/lib/api/topics";
import { loadRunEvents, runNotices } from "@/lib/notices";
import { hrefs } from "@/lib/router";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { Link } from "@/components/app/Link";
import { Badge, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";

/**
 * The run's notices (§6.7, §15): failed pushes and PR updates, incidents (a config change that
 * does not pause the run, an unexplained checkout write…) and merge-level changes, read from
 * the run's event log. Shows nothing while loading, on error or when there is nothing to see:
 * the graph and the feature view stay the page's subject. With `feature`, only that feature's.
 */
export function RunNotices({ run, feature }: { run: string; feature?: string }) {
  const now = useNow();
  const events = useResource(`events:${run}`, (c, s) => loadRunEvents(c, run, s), [
    runTopic(run, "notices"),
  ]);
  const notices = events.data === undefined ? [] : runNotices(events.data, feature);
  if (notices.length === 0) return null;
  return (
    <Card aria-labelledby={`notices-${run}`} className="mb-4">
      <CardHeader>
        <CardTitle id={`notices-${run}`}>Run notices</CardTitle>
        <CardDescription>Recorded by the engine; nothing here waits for an answer.</CardDescription>
      </CardHeader>
      <ul aria-label="Run notices" className="space-y-2">
        {notices.map((n) => (
          <li
            key={n.seq}
            data-type={n.type}
            className="rounded-2xl border border-border bg-surface/60 px-3 py-2 text-sm"
          >
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <Badge tone={n.resolved ? "ok" : n.tone}>
                {n.resolved ? (
                  <CheckCircle2 aria-hidden className="size-3" />
                ) : (
                  <AlertTriangle aria-hidden className="size-3" />
                )}
                {n.resolved ? "Resolved" : n.tone === "danger" ? "Failed" : "Notice"}
              </Badge>
              {n.feature === undefined ? null : (
                <Link className="underline" href={hrefs.feature(run, n.feature)}>
                  {n.feature}
                </Link>
              )}
              <time className="text-muted-fg" dateTime={n.at}>
                {formatLocalTime(n.at, now)}
              </time>
            </div>
            <p className="mt-1 font-medium">{n.title}</p>
            <p className="mt-0.5 break-words text-muted-fg">{n.detail}</p>
            {n.note === null ? null : <p className="mt-0.5 text-xs text-muted-fg">{n.note}</p>}
            {n.evidence.length === 0 ? null : (
              <div className="mt-1 font-mono text-xs break-all">
                {n.evidence.map((e) => (
                  <p key={e}>{e}</p>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
