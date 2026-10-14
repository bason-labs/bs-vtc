"use client";

import { CheckCircle2, ExternalLink, FileText } from "lucide-react";
import { useId } from "react";
import { cn } from "@/lib/cn";
import {
  directionPrototypeUrl,
  type DirectionView,
  type GateFactView,
  type GateRequestView,
} from "@/lib/human-gates";
import { hrefs } from "@/lib/router";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useEngine } from "@/components/app/EngineProvider";
import { Link } from "@/components/app/Link";
import { ArtifactImage } from "@/components/evidence/ArtifactImage";
import { Badge, Card, CardDescription, CardHeader, CardTitle, StatusPill } from "@/components/ui";

function SubHeading({ id, children }: { id: string; children: string }) {
  return (
    <h3 id={id} className="text-xs font-semibold tracking-wide text-muted-fg uppercase">
      {children}
    </h3>
  );
}

function Direction({ run, direction }: { run: string; direction: DirectionView }) {
  const { health } = useEngine();
  const url =
    direction.prototype === null
      ? null
      : directionPrototypeUrl(health?.prototype_url ?? null, direction.prototype);
  return (
    <li
      className={cn(
        "space-y-2 rounded-2xl border p-3 text-sm",
        direction.chosen ? "border-ok/50 bg-ok/5" : "border-border",
      )}
      data-testid={`direction-${direction.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="font-medium">{direction.title}</span>
        {direction.chosen ? (
          <Badge tone="ok">
            <CheckCircle2 aria-hidden className="size-3" /> Chosen
          </Badge>
        ) : null}
        <StatusPill meta={direction.novelty} />
      </div>
      {direction.thesis === null ? null : <p className="text-muted-fg">{direction.thesis}</p>}
      {direction.firstViewport === null ? null : (
        <ArtifactImage
          run={run}
          path={direction.firstViewport}
          alt={`First viewport of ${direction.title}`}
        />
      )}
      {url !== null ? (
        <a
          className="inline-flex items-center gap-1 text-accent-fg underline"
          href={url}
          target="_blank"
          rel="noopener noreferrer"
        >
          Open the prototype <ExternalLink aria-hidden className="size-3.5" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      ) : direction.prototype === null ? null : (
        <p className="font-mono text-xs break-all text-muted-fg">{direction.prototype}</p>
      )}
    </li>
  );
}

function Fact({ fact, pending }: { fact: GateFactView; pending: boolean }) {
  return (
    <li
      className="space-y-1 rounded-xl border border-border p-2 text-xs"
      data-testid={`fact-${fact.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill meta={fact.status} />
        <span className="text-sm font-medium break-words">
          {fact.subject === null ? fact.id : `${fact.subject} · ${fact.predicate ?? ""}`}
        </span>
      </div>
      {fact.reason === null ? null : <p className="text-muted-fg">{fact.reason}</p>}
      {fact.sourceUrl === null ? null : (
        <a
          className="inline-flex items-center gap-1 break-all text-accent-fg underline"
          href={fact.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          {fact.sourceUrl} <ExternalLink aria-hidden className="size-3 shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
      {fact.waiver !== null ? (
        <p>
          <span className="font-medium">Waived:</span> {fact.waiver}
        </p>
      ) : pending ? (
        <p className="text-warn-fg">Needs a waiver with a reason before G2 can pass.</p>
      ) : null}
      <p className="font-mono text-muted-fg">{fact.id}</p>
    </li>
  );
}

/** One gate request (§6.2, §9.1, §8.2): what the human was shown, and what they decided. */
export function GateRequestCard({ run, gate }: { run: string; gate: GateRequestView }) {
  const now = useNow();
  const base = useId();
  const pending = gate.outcome.id === "pending";
  return (
    <Card aria-labelledby={`${base}-title`} data-testid={`gate-request-${String(gate.seq)}`}>
      <CardHeader>
        <div>
          <CardTitle id={`${base}-title`}>{gate.gates}</CardTitle>
          <CardDescription>
            Requested {formatLocalTime(gate.at, now)}
            {gate.decidedAt === null ? null : ` · decided ${formatLocalTime(gate.decidedAt, now)}`}
          </CardDescription>
        </div>
        <StatusPill meta={gate.outcome} />
      </CardHeader>
      <div className="space-y-4">
        {gate.note === null ? null : <p className="text-sm">Note: {gate.note}</p>}
        {gate.directions.length === 0 ? null : (
          <section aria-labelledby={`${base}-dir`} className="space-y-2">
            <SubHeading id={`${base}-dir`}>Design directions</SubHeading>
            <ul className="grid gap-3 md:grid-cols-3">
              {gate.directions.map((d) => (
                <Direction key={d.id} run={run} direction={d} />
              ))}
            </ul>
          </section>
        )}
        {gate.facts.length === 0 ? null : (
          <section aria-labelledby={`${base}-facts`} className="space-y-2">
            <SubHeading id={`${base}-facts`}>Unverified facts</SubHeading>
            <ul className="grid gap-2 md:grid-cols-2">
              {gate.facts.map((f) => (
                <Fact key={f.id} fact={f} pending={pending} />
              ))}
            </ul>
            <Link className="text-xs text-accent-fg underline" href={hrefs.research(run)}>
              All research facts
            </Link>
          </section>
        )}
        {gate.coverage === null ? null : (
          <section aria-labelledby={`${base}-cov`} className="space-y-1">
            <SubHeading id={`${base}-cov`}>Design coverage</SubHeading>
            {gate.coverage.ok ? (
              <p className="text-sm text-ok">
                Every UI requirement has a screen, every screen covers a requirement and every
                component is registered.
              </p>
            ) : (
              <ul className="list-disc pl-5 text-sm text-danger">
                {gate.coverage.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
          </section>
        )}
        <section aria-labelledby={`${base}-art`} className="space-y-1">
          <SubHeading id={`${base}-art`}>Artifacts</SubHeading>
          <ul className="space-y-1 text-xs">
            {gate.artifacts.map((path) => (
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
        </section>
        {pending ? (
          <p className="text-xs text-muted-fg">
            Approval happens in the Lead chat; this page only shows what the gate asks.
          </p>
        ) : null}
      </div>
    </Card>
  );
}
