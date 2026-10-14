"use client";

import { CheckCircle2, XCircle } from "lucide-react";
import type { ChecklistView, FinalReviewStepRow, Level3Item, PreflightView } from "@/lib/level3";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { cn } from "@/lib/cn";
import { Badge, Card, CardDescription, CardHeader, CardTitle, StatusPill } from "@/components/ui";

function Evidence({ items }: { items: readonly string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-0.5 font-mono text-[11px] break-all text-muted-fg">
      {items.map((e) => (
        <li key={e}>{e}</li>
      ))}
    </ul>
  );
}

/** The §6.7a steps of the feature's Final Review: only a pass counts as passed. */
export function FinalReviewStepsCard({ rows }: { rows: readonly FinalReviewStepRow[] }) {
  if (rows.every((r) => r.status === null)) return null;
  return (
    <Card aria-labelledby="fr-steps-title">
      <CardHeader>
        <div>
          <CardTitle id="fr-steps-title">Final Review steps</CardTitle>
          <CardDescription>
            Deterministic first. A skipped or unchecked step is not a pass.
          </CardDescription>
        </div>
      </CardHeader>
      <ol aria-label="Final Review steps" className="space-y-1.5 text-sm">
        {rows.map((r) => (
          <li
            key={r.step}
            className="rounded-xl bg-surface-2 px-3 py-2"
            data-testid={`fr-step-${String(r.step)}`}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="tabular text-muted-fg">{r.step}.</span>
              <span className="font-medium">{r.name}</span>
              {r.status === null ? (
                <Badge className="ml-auto">Not reported yet</Badge>
              ) : (
                <StatusPill meta={r.status} className="ml-auto" />
              )}
            </div>
            {r.reason === null ? null : <p className="mt-0.5 text-xs text-muted-fg">{r.reason}</p>}
            <Evidence items={r.evidence} />
          </li>
        ))}
      </ol>
    </Card>
  );
}

function Checklist({ checklist }: { checklist: ChecklistView }) {
  const now = useNow();
  return (
    <section aria-labelledby="checklist-title" className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <h3 id="checklist-title" className="text-sm font-semibold">
          Safe-to-auto-merge checklist
        </h3>
        <Badge tone={checklist.ok ? "ok" : "danger"}>
          {checklist.ok ? "All seven hold" : "Not safe to auto-merge"}
        </Badge>
        <span className="text-xs text-muted-fg">checked {formatLocalTime(checklist.at, now)}</span>
      </div>
      <ol aria-label="Checklist" className="space-y-1.5 text-sm">
        {checklist.items.map((item) => (
          <li
            key={item.id}
            className={cn(
              "flex gap-2 rounded-xl px-3 py-2",
              item.ok ? "bg-surface-2" : "border border-danger/40 bg-danger/5",
            )}
            data-testid={`check-${item.id}`}
          >
            {item.ok ? (
              <CheckCircle2 aria-hidden className="mt-0.5 size-4 shrink-0 text-ok" />
            ) : (
              <XCircle aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            )}
            <div className="min-w-0">
              <p className="font-medium">
                {item.label}
                <span className="sr-only">{item.ok ? " (holds)" : " (does not hold)"}</span>
              </p>
              <p className="text-xs text-muted-fg">{item.detail}</p>
              <Evidence items={item.evidence} />
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Level 3 (§6.7, AD-23): the preflight at run start (or why the run merges at Level 2), the
 * latest checklist and the auto-merge timeline. Hidden when the run never asked for Level 3.
 */
export function Level3Card({
  preflight,
  checklist,
  timeline,
}: {
  preflight: PreflightView | null;
  checklist: ChecklistView | null;
  timeline: readonly Level3Item[];
}) {
  const now = useNow();
  if (preflight === null && checklist === null && timeline.length === 0) return null;
  return (
    <Card aria-labelledby="level3-title" data-testid="level3">
      <CardHeader>
        <div>
          <CardTitle id="level3-title">Level 3 auto-merge</CardTitle>
          <CardDescription>
            Merges only the gated commit, after remote CI is green; never with an admin bypass.
          </CardDescription>
        </div>
        {preflight === null ? null : (
          <Badge tone={preflight.ok ? "ok" : "warn"}>
            {preflight.ok
              ? `Level ${String(preflight.effective)}`
              : `Configured ${String(preflight.configured)}, running at ${String(preflight.effective)}`}
          </Badge>
        )}
      </CardHeader>
      <div className="space-y-4">
        {preflight === null || preflight.ok ? null : (
          <section aria-label="Preflight" className="space-y-1 text-sm">
            <p className="font-medium">
              The repository is not set up for Level 3, so this run merges at Level{" "}
              {preflight.effective}. To fix:
            </p>
            <ul className="list-disc pl-5">
              {preflight.fixes.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
            {preflight.detail === null ? null : (
              <p className="text-xs text-muted-fg">{preflight.detail}</p>
            )}
            {preflight.policy.length === 0 ? null : (
              <p className="text-xs text-muted-fg">Base branch: {preflight.policy.join(" · ")}</p>
            )}
          </section>
        )}
        {checklist === null ? null : <Checklist checklist={checklist} />}
        {timeline.length === 0 ? null : (
          <ol
            aria-label="Auto-merge timeline"
            className="space-y-1.5 border-l border-border pl-3 text-sm"
          >
            {timeline.map((t) => (
              <li key={t.seq}>
                <p className="flex flex-wrap items-center gap-2">
                  <StatusPill meta={{ label: t.title, tone: t.tone }} />
                  <time className="text-xs text-muted-fg" dateTime={t.at}>
                    {formatLocalTime(t.at, now)}
                  </time>
                </p>
                {t.detail === null ? null : (
                  <p className="mt-0.5 text-xs break-words text-muted-fg">{t.detail}</p>
                )}
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
