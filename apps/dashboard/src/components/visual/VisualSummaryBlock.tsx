"use client";

import type { VisualSummary } from "@vtc/shared";
import { Eye, FileText } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/cn";
import { hrefs } from "@/lib/router";
import { visualSummaryModel } from "@/lib/visual";
import { Link } from "@/components/app/Link";
import { StatusPill } from "@/components/ui";

/**
 * The visual step of a gate run (`GateReport.visual`, AD-24): its status (only `pass` passes;
 * `skipped` and `unchecked` are shown as not passed), why, the counts and its findings, with a
 * link to the full report (render matrix, axe, diffs).
 */
export function VisualSummaryBlock({ run, summary }: { run: string; summary: VisualSummary }) {
  const m = visualSummaryModel(summary);
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-1.5" data-testid="visual-summary">
      <div className="flex items-center gap-2">
        <h4 id={id} className="inline-flex items-center gap-1 text-xs font-semibold">
          <Eye aria-hidden className="size-3.5" /> Visual QA
        </h4>
        <StatusPill meta={m.status} className="ml-auto" />
      </div>
      {m.notes.map((n) => (
        <p key={n} className="text-muted-fg">
          {n}
        </p>
      ))}
      <dl className="grid grid-cols-2 gap-1 sm:grid-cols-4">
        {m.counts.map((c) => (
          <div key={c.label} className="rounded-lg bg-surface-2 px-2 py-1">
            <dt className="text-[11px] text-muted-fg">{c.label}</dt>
            <dd className={cn("font-medium tabular", c.bad && "text-danger")}>{c.value}</dd>
          </div>
        ))}
      </dl>
      {m.findings.length === 0 ? null : (
        <ul className="space-y-1">
          {m.findings.map((f) => (
            <li
              key={`${f.rule_id}-${f.location.path}-${String(f.location.line ?? 0)}`}
              className="rounded-md border border-border px-2 py-1"
            >
              <p className="font-medium">{f.title}</p>
              <p className="font-mono break-all text-muted-fg">
                {f.rule_id} · {f.location.path}
                {f.location.line === undefined ? "" : `:${String(f.location.line)}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {m.report === null ? null : (
        <Link
          className="inline-flex items-center gap-1 text-accent-fg underline"
          href={hrefs.artifact(run, m.report)}
        >
          <FileText aria-hidden className="size-3.5" /> Visual report
        </Link>
      )}
    </section>
  );
}
