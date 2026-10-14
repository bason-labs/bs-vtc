"use client";

import { RESEARCH_FACTS_FILE } from "@vtc/shared";
import { ExternalLink } from "lucide-react";
import { useMemo } from "react";
import { runTopic } from "@/lib/api/topics";
import { currentFacts, factCounts, parseFactsJsonl, type FactView } from "@/lib/facts";
import { hrefs } from "@/lib/router";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { useRunEvents } from "@/lib/useRunEvents";
import { Link } from "@/components/app/Link";
import { Badge, Card, EmptyState, StatusPill } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

function FactItem({ fact, now }: { fact: FactView; now: number }) {
  return (
    <li
      className="space-y-1 rounded-2xl border border-border bg-surface/60 px-3 py-2 text-sm"
      data-testid={`fact-${fact.id}`}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <StatusPill meta={fact.status} />
        <span className="font-medium break-words">
          {fact.subject} · {fact.predicate}
        </span>
        <span className="font-mono break-all">= {fact.value}</span>
        {fact.pinnedVersion === null ? null : <Badge>at {fact.pinnedVersion}</Badge>}
      </div>
      {fact.source === null ? (
        <p className="text-xs text-danger">No source: a claim nobody could check.</p>
      ) : (
        <p className="text-xs text-muted-fg">
          {fact.source.fetcher} ·{" "}
          {fact.source.href === null ? (
            <span className="break-all">{fact.source.url}</span>
          ) : (
            <a
              className="inline-flex items-center gap-1 break-all text-accent-fg underline"
              href={fact.source.href}
              target="_blank"
              rel="noopener noreferrer"
            >
              {fact.source.url}
              <ExternalLink aria-hidden className="size-3 shrink-0" />
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}{" "}
          · {fact.source.locator} · retrieved {formatLocalTime(fact.source.retrievedAt, now)}
        </p>
      )}
      {fact.waiver === null ? null : (
        <p className="text-xs">
          <span className="font-medium">Waived at G2:</span> {fact.waiver}
        </p>
      )}
      <p className="text-xs text-muted-fg">
        <span className="font-mono">{fact.id}</span> · recorded by {fact.recordedBy}{" "}
        {formatLocalTime(fact.recordedAt, now)}
        {fact.expiresAt === null ? "" : ` · fresh until ${formatLocalTime(fact.expiresAt, now)}`}
        {fact.replaced === 0
          ? ""
          : ` · replaces ${String(fact.replaced)} earlier ${fact.replaced === 1 ? "row" : "rows"}`}
      </p>
    </li>
  );
}

/**
 * Research facts (§8.2, §10; AD-22): the current row of every fact in
 * `.vtc/research/facts.jsonl`, what needs attention first, with its source and locator. Only the
 * engine marks a fact verified; anything else blocks G2 unless a human waives it with a reason.
 */
export function ResearchView({ run }: { run: string | null }) {
  const now = useNow();
  const key = run ?? "";
  const file = useResource(
    run === null ? null : `artifact:${key}:${RESEARCH_FACTS_FILE}`,
    (c, s) => c.artifact(key, RESEARCH_FACTS_FILE, s),
    run === null ? [] : [runTopic(key, "research")],
  );
  const events = useRunEvents(run, ["research"]);
  const parsed = useMemo(
    () =>
      file.data === undefined || file.data.encoding !== "utf8"
        ? null
        : parseFactsJsonl(file.data.content),
    [file.data],
  );
  const facts = useMemo(
    () => (parsed === null ? [] : currentFacts(parsed.rows, events.data ?? [])),
    [parsed, events.data],
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: "Research" },
        ]}
      />
      <PageHeader
        title="Research facts"
        eyebrow={<code className="font-mono">{RESEARCH_FACTS_FILE}</code>}
      />
      <Loaded
        resource={file}
        missing={
          <EmptyState
            title="No research facts yet"
            description="The Research Analyst's fetches record facts here, each with its source; the engine decides which are verified."
          />
        }
      >
        {() => (
          <div className="space-y-4">
            <Card>
              <p className="flex flex-wrap items-center gap-1.5 text-sm" aria-label="Fact counts">
                {facts.length} current {facts.length === 1 ? "fact" : "facts"}
                {factCounts(facts).map((c) => (
                  <StatusPill
                    key={c.status.label}
                    meta={{ ...c.status, label: `${String(c.n)} ${c.status.label.toLowerCase()}` }}
                  />
                ))}
              </p>
              <p className="mt-1 text-xs text-muted-fg">
                A fact is verified only when the engine finds its value at its locator in the cached
                source. Unverified, stale and conflicting facts block G2 unless a human waives them
                with a reason (
                <Link className="underline" href={hrefs.gates(run)}>
                  gates
                </Link>
                ).
              </p>
              {parsed === null || parsed.invalid.length === 0 ? null : (
                <p role="alert" className="mt-2 text-xs text-warn-fg">
                  {parsed.invalid.length === 1 ? "Line" : "Lines"} {parsed.invalid.join(", ")} of
                  the file {parsed.invalid.length === 1 ? "is" : "are"} not a fact this dashboard
                  can read; not shown.
                </p>
              )}
            </Card>
            {facts.length === 0 ? null : (
              <ul aria-label="Facts" className="space-y-2">
                {facts.map((f) => (
                  <FactItem key={f.id} fact={f} now={now} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Loaded>
    </>
  );
}
