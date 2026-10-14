"use client";

import type { TaskDetail, WorkflowNode } from "@vtc/shared";
import { ExternalLink, FileText } from "lucide-react";
import { useMemo } from "react";
import { nodeDrawerModel } from "@/lib/flows/drawer";
import { hrefs } from "@/lib/router";
import { nodeStateMeta } from "@/lib/states";
import { formatLocalTime } from "@/lib/time";
import { Link } from "@/components/app/Link";
import { Drawer, StatusPill } from "@/components/ui";
import { DiffSection } from "./DiffSection";
import { FindingItem, Section, Stat } from "./DrawerParts";
import { GateReports } from "./GateReports";
import { nodeEyebrow } from "./StepNode";
import { REDACT } from "@/lib/redact";

export interface NodeDrawerProps {
  readonly run: string;
  readonly node: WorkflowNode | null;
  /** The task behind the pipeline; `null` while it loads. */
  readonly detail: TaskDetail | null;
  readonly onClose: () => void;
}

/**
 * Drill-down for a node of one task's pipeline (§17): role, round n/cap, state and why it was
 * added, findings, evidence, role runs with prompt versions and verdicts, gate reports, the
 * escalation it raised, its timeline, the transcript's location, the plan file, evidence bundle
 * and diff.
 */
export function NodeDrawer({ run, node, detail, onClose }: NodeDrawerProps) {
  const model = useMemo(
    () => (node === null ? null : nodeDrawerModel(node, detail)),
    [node, detail],
  );
  return (
    <Drawer
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={node?.label ?? ""}
      eyebrow={node === null ? undefined : nodeEyebrow({ node, meta: nodeStateMeta(node) })}
      data-testid="node-drawer"
    >
      {node === null || model === null ? null : (
        <>
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="State">
              <StatusPill meta={nodeStateMeta(node)} />
            </Stat>
            <Stat label="Round">{model.round ?? "—"}</Stat>
            <Stat label="Role">{model.role ?? "— (engine)"}</Stat>
            <Stat label="Task">{node.task ?? "—"}</Stat>
          </dl>

          <Section title="Why this node">
            <p className="text-sm">{node.reason_added}</p>
            {model.parked === null ? null : (
              <p className="text-sm text-danger">Parked: {model.parked}</p>
            )}
            {model.tokens === null ? null : (
              <p className="text-xs text-muted-fg tabular">Tokens: {model.tokens}</p>
            )}
            {node.ports_in.length + node.ports_out.length === 0 ? null : (
              <p className="text-xs text-muted-fg">
                In: {node.ports_in.join(", ") || "—"} · Out: {node.ports_out.join(", ") || "—"}
              </p>
            )}
          </Section>

          <Section title="Findings" count={model.findings.length}>
            {model.findings.length === 0 ? (
              <p className="text-xs text-muted-fg">
                {detail === null ? "Loading…" : "No findings for this node."}
              </p>
            ) : (
              <ul className="space-y-2">
                {model.findings.map((f) => (
                  <FindingItem key={f.fingerprint} finding={f} />
                ))}
              </ul>
            )}
          </Section>

          <Section title="Evidence" count={model.evidence.length}>
            {model.evidence.length === 0 ? (
              <p className="text-xs text-muted-fg">No evidence cited.</p>
            ) : (
              <ul className="space-y-1 font-mono text-xs break-all">
                {model.evidence.map((e) => (
                  <li key={e} className="rounded-lg bg-surface-2 px-2 py-1">
                    {e}
                  </li>
                ))}
              </ul>
            )}
          </Section>

          {model.roleRuns.length === 0 ? null : (
            <Section title="Role runs" count={model.roleRuns.length}>
              <ul className="space-y-2 text-xs">
                {model.roleRuns.map((r) => (
                  <li key={r.action_id} className="space-y-0.5 rounded-xl border border-border p-2">
                    <p className="font-medium">
                      {r.action_id} · {r.host} · {r.model}
                    </p>
                    <p className="text-muted-fg">
                      exit {r.exit ?? "in flight"} · prompt{" "}
                      <span className="font-mono">{r.prompt_sha.slice(0, 12)}</span>
                    </p>
                    {r.verdicts.length === 0 ? null : (
                      <p>{r.verdicts.map((v) => `${v.subject}: ${v.verdict}`).join(" · ")}</p>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {model.gateReports.length === 0 ? null : (
            <Section title="Gate reports" count={model.gateReports.length}>
              <GateReports run={run} reports={model.gateReports} />
            </Section>
          )}

          {model.escalations.length === 0 ? null : (
            <Section title="Escalation">
              {model.escalations.map((e) => (
                <p key={e.id} className="text-sm">
                  <b>{e.id}</b>: {e.question}{" "}
                  <Link className="text-accent-fg underline" href={hrefs.escalations(run)}>
                    See escalations
                  </Link>
                </p>
              ))}
              <p className="text-xs text-muted-fg">Answers happen in the Lead chat.</p>
            </Section>
          )}

          <Section title="Timeline" count={model.timeline.length}>
            {model.timeline.length === 0 ? (
              <p className="text-xs text-muted-fg">
                {detail === null ? "Loading…" : "Nothing has happened at this node yet."}
              </p>
            ) : (
              <ol className="space-y-1.5 border-l border-border pl-3 text-xs" aria-label="Timeline">
                {model.timeline.map((t, i) => (
                  <li key={`${t.at}-${String(i)}`} className="space-y-0.5">
                    <p>
                      <time className="tabular text-muted-fg" dateTime={t.at} title={t.at}>
                        {formatLocalTime(t.at, Date.now())}
                      </time>{" "}
                      <span className="font-medium">{t.label}</span>
                    </p>
                    {t.detail === null ? null : (
                      <p className="break-words text-muted-fg" {...REDACT}>
                        {t.detail}
                      </p>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title="Transcript">
            <p className="text-xs">
              {model.transcript.session === null ? (
                "No host session recorded yet."
              ) : (
                <span {...REDACT}>Host {model.transcript.session}.</span>
              )}{" "}
              <span className="text-muted-fg">
                Full transcripts stay on this machine in{" "}
                <code className="font-mono">{model.transcript.location}</code>; the engine does not
                serve them to the browser.
              </span>
            </p>
          </Section>

          {detail === null ? null : (
            <Section title="Files">
              <ul className="space-y-1 text-sm">
                <li>
                  <Link
                    className="inline-flex items-center gap-1 text-accent-fg underline"
                    href={hrefs.artifact(run, detail.plan_file)}
                  >
                    <FileText aria-hidden className="size-3.5" /> Plan file {detail.plan_file}
                  </Link>
                </li>
                {detail.evidence_bundle === null ? (
                  <li className="text-xs text-muted-fg">No evidence bundle yet.</li>
                ) : (
                  <li>
                    <Link
                      className="inline-flex items-center gap-1 text-accent-fg underline"
                      href={hrefs.artifact(run, detail.evidence_bundle)}
                    >
                      <ExternalLink aria-hidden className="size-3.5" /> Evidence bundle
                    </Link>
                  </li>
                )}
              </ul>
            </Section>
          )}

          {detail?.diff == null || node.role !== "engineer" ? null : (
            <DiffSection run={run} task={detail.task.id} />
          )}
        </>
      )}
    </Drawer>
  );
}
