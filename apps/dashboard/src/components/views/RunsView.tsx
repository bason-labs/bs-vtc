"use client";

import { ChevronRight, PauseCircle } from "lucide-react";
import { hrefs } from "@/lib/router";
import { PHASE_LABELS } from "@/lib/states";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { useEngine } from "@/components/app/EngineProvider";
import { Link } from "@/components/app/Link";
import { Badge, Card, CardDescription, CardHeader, CardTitle, EmptyState } from "@/components/ui";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { Loaded, PageHeader } from "./common";

/** Home: every run in this repo (newest first) and the usage panel. */
export function RunsView() {
  const { health } = useEngine();
  const now = useNow();
  const runs = useResource("runs", (c, s) => c.runs(s), ["runs"]);
  const usage = useResource("usage", (c, s) => c.usage(s), ["usage"]);
  return (
    <>
      <PageHeader
        title="Runs"
        eyebrow={
          health === null
            ? "Flow Studio"
            : `${health.mode === "live" ? "Live engine" : "Snapshot of committed .vtc/"} · engine ${health.engine_version} · contracts ${health.contracts_version}`
        }
      />
      <Loaded resource={runs} skeleton="h-24">
        {(list) =>
          list.runs.length === 0 ? (
            <EmptyState
              title="No runs yet"
              description="Start one from the Lead chat in Claude Code or Codex."
            />
          ) : (
            <ul className="grid gap-3 md:grid-cols-2" aria-label="Runs">
              {[...list.runs]
                .sort((a, b) => b.started_at.localeCompare(a.started_at))
                .map((r) => (
                  <li key={r.id}>
                    <Link
                      href={hrefs.run(r.id)}
                      className="flex items-center justify-between gap-3 rounded-3xl border border-border bg-surface/70 p-4 backdrop-blur-md transition hover:border-accent"
                    >
                      <span className="min-w-0 space-y-1">
                        <span className="block font-display text-base font-semibold">{r.id}</span>
                        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-fg">
                          <Badge tone="brand">{r.track.replace(/_/g, " ")}</Badge>
                          <Badge tone={r.finished_at === undefined ? "accent" : "ok"}>
                            {r.finished_at === undefined ? PHASE_LABELS[r.phase] : "Finished"}
                          </Badge>
                          {r.paused ? (
                            <Badge tone="warn">
                              <PauseCircle aria-hidden className="size-3" /> Paused
                            </Badge>
                          ) : null}
                          <span>started {formatLocalTime(r.started_at, now)}</span>
                        </span>
                      </span>
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-fg" />
                    </Link>
                  </li>
                ))}
            </ul>
          )
        }
      </Loaded>
      <Card className="mt-6 border-none bg-transparent p-0 backdrop-blur-none sm:p-0">
        <CardHeader>
          <div>
            <CardTitle>Usage</CardTitle>
            <CardDescription>
              Subscription windows per host. Missing data shows as unknown, never 0%.
            </CardDescription>
          </div>
        </CardHeader>
        <Loaded resource={usage} skeleton="h-48">
          {(report) => <UsagePanel report={report} />}
        </Loaded>
      </Card>
    </>
  );
}
