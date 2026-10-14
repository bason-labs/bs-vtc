"use client";

import type { VisualReport } from "@vtc/shared";
import { ImageIcon } from "lucide-react";
import { useId, useMemo } from "react";
import { cn } from "@/lib/cn";
import { hrefs } from "@/lib/router";
import {
  renderMatrix,
  visualDiffs,
  visualNotes,
  visualStatusMeta,
  visualToolchain,
} from "@/lib/visual";
import { Link } from "@/components/app/Link";
import { Badge, Card, CardDescription, CardHeader, CardTitle, StatusPill } from "@/components/ui";
import { VisualNotes } from "./VisualNotes";

const th = "px-3 py-2 font-medium";
const td = "border-t border-border px-3 py-2 align-top";

function ImageLink({ run, path, label }: { run: string; path: string | null; label: string }) {
  if (path === null) return null;
  return (
    <Link
      href={hrefs.artifact(run, path)}
      className="inline-flex items-center gap-1 text-accent-fg underline"
    >
      <ImageIcon aria-hidden className="size-3" />
      {label}
    </Link>
  );
}

/** Screen × state rows, width × theme columns (§7.5 step 2); a cell passes only when clean. */
function Matrix({ run, report }: { run: string; report: VisualReport }) {
  const m = useMemo(() => renderMatrix(report), [report]);
  const caption = useId();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle id={caption}>Render matrix</CardTitle>
          <CardDescription>
            {m.summary.passed} of {m.summary.cells} renders clean. Unreached is not clean.
          </CardDescription>
        </div>
      </CardHeader>
      {m.rows.length === 0 ? (
        <p className="text-sm text-muted-fg">Nothing was rendered.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table aria-labelledby={caption} className="w-full min-w-[32rem] text-left text-xs">
            <thead className="bg-surface-2 text-muted-fg">
              <tr>
                <th scope="col" className={th}>
                  Screen · state
                </th>
                {m.columns.map((c) => (
                  <th key={c.key} scope="col" className={th}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.rows.map((row) => (
                <tr key={row.key}>
                  <th scope="row" className={cn(td, "font-mono font-medium")}>
                    {row.label}
                  </th>
                  {row.cells.map((cell) => (
                    <td key={cell.key} className={td} data-testid={`render-${cell.key}`}>
                      <StatusPill meta={{ label: cell.label, tone: cell.tone }} />
                      {cell.issues.length === 0 ? null : (
                        <ul className="mt-1 text-danger">
                          {cell.issues.map((i) => (
                            <li key={i}>{i}</li>
                          ))}
                        </ul>
                      )}
                      {cell.detail === null ? null : (
                        <p className="mt-1 text-muted-fg">{cell.detail}</p>
                      )}
                      <p className="mt-1 flex flex-wrap gap-x-2">
                        <ImageLink run={run} path={cell.screenshot} label="screenshot" />
                        <ImageLink run={run} path={cell.reference} label="prototype" />
                      </p>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

const IMPACT_TONE = {
  critical: "danger",
  serious: "danger",
  moderate: "warn",
  minor: "neutral",
} as const;

function Axe({ report }: { report: VisualReport }) {
  const rows = report.axe.filter((a) => a.violations.length + a.incomplete.length > 0);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Accessibility (axe)</CardTitle>
          <CardDescription>
            Items axe could not decide need review and never count as passed.
          </CardDescription>
        </div>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-fg">No violations and nothing left to review.</p>
      ) : (
        <ul aria-label="Axe results" className="space-y-2 text-xs">
          {rows.map((a) => (
            <li key={a.key} className="rounded-xl border border-border p-2">
              <p className="font-mono font-medium">{a.key}</p>
              <ul className="mt-1 space-y-1">
                {a.violations.map((v) => (
                  <li key={`v-${v.rule}`} className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={v.impact === null ? "neutral" : IMPACT_TONE[v.impact]}>
                      {v.impact ?? "violation"}
                    </Badge>
                    <span className="font-mono">{v.rule}</span>
                    <span>{v.help}</span>
                    <span className="text-muted-fg">
                      {v.nodes} {v.nodes === 1 ? "node" : "nodes"}
                    </span>
                  </li>
                ))}
                {a.incomplete.map((v) => (
                  <li key={`i-${v.rule}`} className="flex flex-wrap items-center gap-1.5">
                    <Badge tone="warn">needs review</Badge>
                    <span className="font-mono">{v.rule}</span>
                    <span>{v.help}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Diffs({ run, report }: { run: string; report: VisualReport }) {
  const diffs = useMemo(() => visualDiffs(report), [report]);
  const caption = useId();
  if (diffs.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle id={caption}>Pixel diffs against the prototype</CardTitle>
          <CardDescription>
            Per region, rendered in the same run by the same browser.
          </CardDescription>
        </div>
      </CardHeader>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table aria-labelledby={caption} className="w-full min-w-[32rem] text-left text-xs">
          <thead className="bg-surface-2 text-muted-fg">
            <tr>
              <th scope="col" className={th}>
                Render
              </th>
              <th scope="col" className={th}>
                Region
              </th>
              <th scope="col" className={th}>
                Changed
              </th>
              <th scope="col" className={th}>
                Result
              </th>
            </tr>
          </thead>
          <tbody>
            {diffs.map((d) => (
              <tr key={`${d.key}-${d.region}`}>
                <td className={cn(td, "font-mono")}>{d.key}</td>
                <td className={td}>{d.region}</td>
                <td className={cn(td, "tabular")}>
                  {d.ratio}
                  <span className="block text-muted-fg">
                    {d.mismatchPx.toLocaleString("en-US")} px
                  </span>
                </td>
                <td className={td}>
                  <Badge tone={d.overBudget ? "danger" : "ok"}>
                    {d.overBudget ? "Over budget" : "Within budget"}
                  </Badge>
                  <p className="mt-1">
                    <ImageLink run={run} path={d.image} label="diff image" />
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function Styles({ report }: { report: VisualReport }) {
  if (report.computed_style.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Computed styles off the tokens</CardTitle>
      </CardHeader>
      <ul aria-label="Style mismatches" className="space-y-1 text-xs">
        {report.computed_style.map((s) => (
          <li
            key={`${s.key}-${s.selector}-${s.property}`}
            className="rounded-lg bg-surface-2 px-2 py-1.5"
          >
            <p className="font-mono break-all">
              {s.selector} · {s.property}: {s.value}
            </p>
            <p className="text-muted-fg">
              {s.key} · nearest token {s.nearest_token ?? "none"} · ΔE {s.delta}
            </p>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** A visual QA report (AD-24) instead of raw JSON: matrix, axe, diffs, styles, findings. */
export function VisualReportView({ run, report }: { run: string; report: VisualReport }) {
  const status = visualStatusMeta(report.status);
  const notes = visualNotes(report.status);
  const subject = report.task ?? report.feature ?? report.run;
  return (
    <div className="space-y-4" data-testid="visual-report">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Visual QA of {subject}</CardTitle>
            <CardDescription>
              {report.browser === null
                ? "No browser"
                : `${report.browser.name} ${report.browser.version} (pinned ${report.browser.executable_sha256.slice(0, 12)})`}{" "}
              · written {new Date(report.written_at).toLocaleString()}
            </CardDescription>
          </div>
          <StatusPill meta={status} />
        </CardHeader>
        <VisualNotes
          className="text-sm"
          reason={report.skipped_reason ?? null}
          notes={notes}
          toolchain={visualToolchain(report.toolchain, report.status)}
        />
        {report.findings.length === 0 ? null : (
          <ul aria-label="Visual findings" className="mt-2 space-y-1 text-xs">
            {report.findings.map((f) => (
              <li
                key={`${f.rule_id}-${f.location.path}-${String(f.location.line ?? 0)}`}
                className="rounded-md border border-border px-2 py-1"
              >
                <p className="font-medium">{f.title}</p>
                <p className="font-mono break-all text-muted-fg">
                  {f.rule_id} · {f.location.path}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Matrix run={run} report={report} />
      <Axe report={report} />
      <Diffs run={run} report={report} />
      <Styles report={report} />
    </div>
  );
}
