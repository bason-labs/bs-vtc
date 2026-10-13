"use client";

import type { GateReport } from "@vtc/shared";
import { ChevronRight, FileText, Table2 } from "lucide-react";
import { useId, useMemo } from "react";
import { gateReportModel, type GateLayerGroup } from "@/lib/gates";
import { hrefs } from "@/lib/router";
import { Link } from "@/components/app/Link";
import { Badge, StatusPill } from "@/components/ui";

const linkClass = "inline-flex items-center gap-1 text-accent-fg underline";

function Layer({ run, group }: { run: string; group: GateLayerGroup }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <div className="flex items-center gap-2">
        <h4 id={id} className="text-xs font-semibold">
          <span className="font-mono">{group.layer}</span> {group.label}
        </h4>
        <StatusPill meta={group.status} className="ml-auto" />
      </div>
      <ul className="space-y-1.5">
        {group.results.map((r) => (
          <li key={r.id} className="space-y-1 rounded-lg bg-surface-2 px-2 py-1.5">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono font-medium">{r.id}</span>
              <StatusPill meta={r.status} />
              {r.blocking ? null : <Badge>warn only</Badge>}
            </div>
            <ul className="text-muted-fg">
              {r.details.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
            {r.findings.length === 0 ? null : (
              <ul className="space-y-1">
                {r.findings.map((f) => (
                  <li
                    key={`${f.rule_id}-${f.location.path}-${String(f.location.line ?? 0)}`}
                    className="rounded-md border border-border px-2 py-1"
                  >
                    <p className="font-medium">{f.title}</p>
                    <p className="font-mono break-all text-muted-fg">
                      {f.tool} · {f.location.path}
                      {f.location.line === undefined ? "" : `:${String(f.location.line)}`} ·{" "}
                      {f.rule_id}
                    </p>
                  </li>
                ))}
              </ul>
            )}
            {r.report === null ? null : (
              <Link className={linkClass} href={hrefs.artifact(run, r.report.path)}>
                <FileText aria-hidden className="size-3.5" />
                {r.report.format} report
              </Link>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Gate reports of a task (§17 drill-down), newest first: verdict, commit range and duration, then
 * each layer (§7.2 L0–L6) with its gates' violations, failure class, test counts, coverage,
 * regressions (§7.3), tool findings and the redacted report. Older runs start collapsed.
 */
export function GateReports({ run, reports }: { run: string; reports: readonly GateReport[] }) {
  const models = useMemo(
    () =>
      [...reports]
        .sort((a, b) => b.started_at.localeCompare(a.started_at))
        .map((r) => ({ key: `${r.reason}-${r.started_at}`, model: gateReportModel(r) })),
    [reports],
  );
  return (
    <ol className="space-y-2 text-xs">
      {models.map(({ key, model }, i) => (
        <li key={key}>
          <details
            open={i === 0}
            className="group rounded-xl border border-border p-2"
            data-testid={`gate-report-${String(i)}`}
          >
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 rounded-lg">
              <ChevronRight
                aria-hidden
                className="size-3.5 transition group-open:rotate-90 motion-reduce:transition-none"
              />
              <span className="font-medium">{model.title}</span>
              <StatusPill meta={model.verdict} />
              <span className="ml-auto font-mono text-muted-fg">
                {model.range} · {model.duration}
              </span>
            </summary>
            <div className="mt-2 space-y-3">
              {model.layers.map((g) => (
                <Layer key={g.layer} run={run} group={g} />
              ))}
              {model.traceability === null ? null : (
                <Link className={linkClass} href={hrefs.artifact(run, model.traceability)}>
                  <Table2 aria-hidden className="size-3.5" /> Traceability matrix
                </Link>
              )}
            </div>
          </details>
        </li>
      ))}
    </ol>
  );
}
