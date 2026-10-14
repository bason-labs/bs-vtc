import type { ReactNode } from "react";
import type { Finding, Severity } from "@vtc/shared";
import { Badge } from "@/components/ui";
import type { Tone } from "@/lib/states";
import { REDACT } from "@/lib/redact";

export function Stat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-xl bg-surface-2 p-2">
      <dt className="text-[11px] text-muted-fg">{label}</dt>
      <dd className="truncate text-sm font-medium">{children}</dd>
    </div>
  );
}

export function Section({
  title,
  children,
  count,
}: {
  title: string;
  children: ReactNode;
  count?: number;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">
        {title}
        {count === undefined ? null : <span className="ml-1 tabular">({count})</span>}
      </h3>
      {children}
    </section>
  );
}

const SEVERITY_TONE: Readonly<Record<Severity, Tone>> = {
  critical: "danger",
  high: "danger",
  medium: "warn",
  low: "neutral",
  info: "neutral",
};

const where = (f: Finding): string => {
  const { path, line, symbol } = f.location;
  return `${path}${line === undefined ? "" : `:${String(line)}`}${symbol === undefined ? "" : ` (${symbol})`}`;
};

/** One finding as the engine recorded it after triage (§16 Finding). */
export function FindingItem({ finding }: { finding: Finding }) {
  const rounds =
    finding.round_last_seen === undefined || finding.round_last_seen === finding.round_first_seen
      ? `round ${String(finding.round_first_seen)}`
      : `rounds ${String(finding.round_first_seen)}–${String(finding.round_last_seen)}`;
  return (
    <li className="space-y-1 rounded-xl border border-border p-3 text-xs">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge tone={SEVERITY_TONE[finding.severity]}>{finding.severity}</Badge>
        <Badge>{finding.status}</Badge>
        <Badge tone="brand">route: {finding.route.replace(/_/g, " ")}</Badge>
      </div>
      <p className="text-sm font-medium">{finding.title}</p>
      {finding.message === undefined ? null : (
        <p className="text-muted-fg" {...REDACT}>
          {finding.message}
        </p>
      )}
      <p className="text-muted-fg">
        {finding.source_name} · {finding.category} · {finding.rule_id} · {rounds}
      </p>
      <p className="font-mono break-all">{where(finding)}</p>
      {finding.req_ids.length === 0 ? null : (
        <p className="text-muted-fg">Covers {finding.req_ids.join(", ")}</p>
      )}
    </li>
  );
}
