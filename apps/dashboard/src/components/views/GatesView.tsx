"use client";

import { useMemo } from "react";
import { gateRequests } from "@/lib/human-gates";
import { hrefs } from "@/lib/router";
import { useRunEvents } from "@/lib/useRunEvents";
import { GateRequestCard } from "@/components/gates/GateRequestCard";
import { EmptyState } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

/**
 * The run's human gates (§6.2): each G1/G2 request with the G2 design directions, the facts
 * still unverified and the design coverage check, newest first, read from `gate.requested` and
 * the decisions that followed (spine §5 reading 109). Read-only: the Lead chat decides.
 */
export function GatesView({ run }: { run: string | null }) {
  const events = useRunEvents(run, ["gates"]);
  const gates = useMemo(
    () => (events.data === undefined ? [] : gateRequests(events.data)),
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
        {() =>
          gates.length === 0 ? (
            <EmptyState
              title="No gate requested yet"
              description="The engine asks for G1 after SPECIFY and for G2 after DESIGN; the Lead shows them in its chat."
            />
          ) : (
            <div className="space-y-4">
              {gates.map((g) => (
                <GateRequestCard key={g.seq} run={run} gate={g} />
              ))}
            </div>
          )
        }
      </Loaded>
    </>
  );
}
