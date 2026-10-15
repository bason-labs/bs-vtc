"use client";

import type { TaskDetail } from "@vtc/shared";
import { useMemo } from "react";
import { REDACT } from "@/lib/redact";
import { taskRouting, type TierView } from "@/lib/routing";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { Badge, Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";

/** `Mid` with its reason and, when the project's routing moved it, the clamp. */
export function TierLine({ tier }: { tier: TierView }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <Badge tone="brand">{tier.tier}</Badge>
      <span>{tier.reason}</span>
      {tier.clamped === null ? null : <Badge tone="warn">{tier.clamped}</Badge>}
    </span>
  );
}

/**
 * Model routing of one task (H-9, D-cm; spine §5 reading 218): the Planner's tier hint and, for
 * each role run with a recorded tier, the tier it started on and why. Runs logged before 5.4.0
 * have no tier and are left out; with neither a hint nor a routed run nothing is shown.
 */
export function TaskRouting({ detail }: { detail: TaskDetail }) {
  const now = useNow();
  const routing = useMemo(() => taskRouting(detail), [detail]);
  if (routing.hint === null && routing.runs.length === 0) return null;
  return (
    <Card aria-labelledby="task-routing">
      <CardHeader>
        <div>
          <CardTitle id="task-routing">Model routing</CardTitle>
          <CardDescription>
            The tier each role run started on and why. The task&apos;s size and risk pick it, unless
            the Planner gave a hint; failed rounds and the reviewers&apos; budget move it later.
          </CardDescription>
        </div>
      </CardHeader>
      {routing.hint === null ? null : (
        <div
          className="mb-3 rounded-2xl border border-border bg-surface-2/60 px-3 py-2 text-sm"
          data-testid="tier-hint"
        >
          <p className="flex flex-wrap items-center gap-1.5">
            <span className="font-medium">Planner hint: start on</span>
            <Badge tone="brand">{routing.hint.tier}</Badge>
            <code className="font-mono text-xs">{routing.hint.code}</code>
            <span className="text-muted-fg">({routing.hint.reason})</span>
          </p>
          {routing.hint.detail === null ? null : (
            <p className="mt-0.5 text-xs text-muted-fg" {...REDACT}>
              {routing.hint.detail}
            </p>
          )}
        </div>
      )}
      {routing.runs.length === 0 ? null : (
        <ol aria-label="Role runs and their tier" className="space-y-1.5 text-sm">
          {routing.runs.map((r) => (
            <li key={r.action} className="rounded-2xl border border-border px-3 py-2">
              <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium">{r.role}</span>
                <span className="font-mono text-xs text-muted-fg" {...REDACT}>
                  {r.action}
                </span>
                <span className="text-xs text-muted-fg">
                  {r.host} · {r.model}
                </span>
                <time className="text-xs text-muted-fg" dateTime={r.at}>
                  {formatLocalTime(r.at, now)}
                </time>
              </p>
              <p className="mt-0.5 text-xs">
                <TierLine tier={r.tier} />
              </p>
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}
