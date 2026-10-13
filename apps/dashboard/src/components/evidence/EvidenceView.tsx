"use client";

import { FileText } from "lucide-react";
import { Fragment, useId, useMemo } from "react";
import { bundleFacts, traceMatrix, type EvidenceDoc } from "@/lib/evidence";
import { hrefs } from "@/lib/router";
import type { TraceabilityReport } from "@vtc/shared";
import { Link } from "@/components/app/Link";
import { Badge, Card, CardDescription, CardHeader, CardTitle, StatusPill } from "@/components/ui";

/** The REQ → test → result matrix (§7.4 traceability, §6.7a evidence). */
export function TraceMatrixTable({ report }: { report: TraceabilityReport }) {
  const m = useMemo(() => traceMatrix(report), [report]);
  const captionId = useId();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle id={captionId}>Traceability</CardTitle>
          <CardDescription>
            {m.summary.covered} of {m.summary.reqs} requirements covered · {m.summary.passing} of{" "}
            {m.summary.tests} tests passing
            {m.summary.failing > 0 ? ` · ${String(m.summary.failing)} failing` : ""}
          </CardDescription>
        </div>
        {m.gaps.length === 0 ? (
          <Badge tone="ok">No gaps</Badge>
        ) : (
          <Badge tone="danger">Gaps: {m.gaps.join(", ")}</Badge>
        )}
      </CardHeader>
      {/* Phones: one block per requirement; the table needs more width than a phone has. */}
      <ul aria-label="Requirements" className="space-y-2 sm:hidden">
        {m.rows.map((row) => (
          <li key={row.req} className="rounded-xl border border-border p-2 text-xs">
            <p className="flex items-center gap-2 font-mono font-medium">
              {row.req}
              <span className={row.covered ? "text-ok" : "text-danger"}>
                {row.covered ? "covered" : "not covered"}
              </span>
            </p>
            {row.tests.length === 0 ? (
              <p className="mt-1 text-danger">No test covers this requirement.</p>
            ) : (
              <ul className="mt-1 space-y-1.5">
                {row.tests.map((t) => (
                  <li key={t.id} className="rounded-lg bg-surface-2 px-2 py-1.5">
                    <p className="font-mono break-words">{t.id}</p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-fg">
                      <StatusPill meta={t.status} />
                      {t.hidden ? <Badge tone="brand">hidden</Badge> : null}
                      <span>assertions from {t.provenance}</span>
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
      <div className="hidden overflow-x-auto rounded-xl border border-border sm:block">
        <table aria-labelledby={captionId} className="w-full min-w-[34rem] text-left text-xs">
          <thead className="bg-surface-2 text-muted-fg">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">
                Requirement
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Test
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Result
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                Assertions from
              </th>
            </tr>
          </thead>
          <tbody>
            {m.rows.map((row) => {
              const span = Math.max(row.tests.length, 1);
              const head = (
                <th
                  scope="row"
                  rowSpan={span}
                  className="border-t border-border px-3 py-2 align-top font-mono font-medium"
                >
                  <span className="block">{row.req}</span>
                  <span className={row.covered ? "text-ok" : "text-danger"}>
                    {row.covered ? "covered" : "not covered"}
                  </span>
                </th>
              );
              if (row.tests.length === 0) {
                return (
                  <tr key={row.req}>
                    {head}
                    <td colSpan={3} className="border-t border-border px-3 py-2 text-danger">
                      No test covers this requirement.
                    </td>
                  </tr>
                );
              }
              return (
                <Fragment key={row.req}>
                  {row.tests.map((t, i) => (
                    <tr key={t.id}>
                      {i === 0 ? head : null}
                      <td className="border-t border-border px-3 py-2 font-mono break-all">
                        {t.id}
                        {t.hidden ? (
                          <Badge tone="brand" className="ml-1.5">
                            hidden
                          </Badge>
                        ) : null}
                      </td>
                      <td className="border-t border-border px-3 py-2">
                        <StatusPill meta={t.status} />
                      </td>
                      <td className="border-t border-border px-3 py-2 text-muted-fg">
                        {t.provenance}
                      </td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {m.scopeCreep.length === 0 ? null : (
        <p className="mt-3 text-xs text-warn-fg">
          Changed files no requirement covers (scope creep):{" "}
          <span className="font-mono break-all">{m.scopeCreep.join(", ")}</span>
        </p>
      )}
    </Card>
  );
}

/** An evidence bundle (AD-18 rule 4) or a traceability report, rendered instead of raw JSON. */
export function EvidenceDocView({ run, doc }: { run: string; doc: EvidenceDoc }) {
  if (doc.kind === "traceability") return <TraceMatrixTable report={doc.report} />;
  const facts = bundleFacts(doc.bundle);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>{facts.title}</CardTitle>
          <CardDescription>
            Written {new Date(doc.bundle.written_at).toLocaleString()}
          </CardDescription>
        </CardHeader>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {facts.stats.map((s) => (
            <div key={s.label} className="min-w-0 rounded-xl bg-surface-2 p-2">
              <dt className="text-[11px] text-muted-fg">{s.label}</dt>
              <dd className="text-sm font-medium break-words">{s.value}</dd>
            </div>
          ))}
        </dl>
        {facts.tasks.length === 0 ? null : (
          <ul aria-label="Tasks" className="mt-3 space-y-1 text-sm">
            {facts.tasks.map((t) => (
              <li key={t.task}>
                <Link className="text-accent-fg underline" href={hrefs.task(run, t.task)}>
                  {t.task}
                </Link>{" "}
                <span className="text-muted-fg">{t.detail}</span>
              </li>
            ))}
          </ul>
        )}
        {facts.verdicts.length === 0 ? null : (
          <ul aria-label="Verdicts" className="mt-3 space-y-1 text-xs">
            {facts.verdicts.map((v) => (
              <li key={`${v.role}-${v.subject}`}>
                {v.role} · {v.subject}: {v.verdict}{" "}
                <span className="text-muted-fg">
                  (prompt <span className="font-mono">{v.prompt}</span>)
                </span>
              </li>
            ))}
          </ul>
        )}
        {facts.gateReports.length === 0 ? null : (
          <ul aria-label="Gate reports" className="mt-3 space-y-1 text-xs">
            {facts.gateReports.map((path) => (
              <li key={path}>
                <Link
                  className="inline-flex items-center gap-1 font-mono break-all text-accent-fg underline"
                  href={hrefs.artifact(run, path)}
                >
                  <FileText aria-hidden className="size-3.5 shrink-0" />
                  {path}
                </Link>
              </li>
            ))}
          </ul>
        )}
        {facts.deferred.length === 0 ? null : (
          <p className="mt-3 text-xs text-muted-fg">
            Deferred findings: <span className="font-mono">{facts.deferred.join(", ")}</span>
          </p>
        )}
      </Card>
      <TraceMatrixTable report={doc.bundle.traceability} />
    </div>
  );
}
