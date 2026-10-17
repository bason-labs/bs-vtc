"use client";

import { useMemo } from "react";
import { coverageLoop } from "@/lib/design-coverage";
import { gateRequests } from "@/lib/human-gates";
import { hrefs } from "@/lib/router";
import { useRunEvents } from "@/lib/useRunEvents";
import { CoverageLoopCard } from "@/components/gates/CoverageLoopCard";
import { GateRequestCard } from "@/components/gates/GateRequestCard";
import { EventLogTruncated } from "@/components/notices/EventLogTruncated";
import { EmptyState } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

/**
 * The run's human gates (§6.2): each G1/G2 request with the G2 design directions, the facts
 * still unverified and the design coverage check, newest first, read from `gate.requested` and
 * the decisions that followed (spine §5 reading 109), with the G2 coverage loop's status above
 * them (`design.coverage_checked`, H-13). Read-only: the Lead chat decides.
 */
export function GatesView({ run }: { run: string | null }) {
  const events = useRunEvents(run, ["gates"]);
  const gates = useMemo(
    () => (events.data === undefined ? [] : gateRequests(events.data.events)),
    [events.data],
  );
  const loop = useMemo(
    () => (events.data === undefined ? null : coverageLoop(events.data.events)),
    [events.data],
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: "Gates" },
        ]}
      />
      <PageHeader title="Human gates" eyebrow="What the Lead showed at G1 and G2" />
      <Loaded resource={events}>
        {() => (
          <div className="space-y-4">
            {events.data?.truncated === true ? <EventLogTruncated /> : null}
            {loop === null ? null : <CoverageLoopCard run={run} loop={loop} />}
            {gates.length === 0 ? (
              <EmptyState
                title="No gate requested yet"
                description="The engine asks for G1 after SPECIFY and for G2 after DESIGN, once every requirement is covered; the Lead shows them in its chat."
              />
            ) : (
              gates.map((g) => <GateRequestCard key={g.seq} run={run} gate={g} />)
            )}
          </div>
        )}
      </Loaded>
    </>
  );
}
