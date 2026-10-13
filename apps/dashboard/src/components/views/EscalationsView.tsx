"use client";

import { MessageSquareText } from "lucide-react";
import { runTopic } from "@/lib/api/topics";
import { sortEscalations } from "@/lib/escalations";
import { hrefs } from "@/lib/router";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { EscalationCard } from "@/components/escalations/EscalationCard";
import { EmptyState } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

/** Escalations of a run (§6.5), read-only: answers happen in the Lead chat. */
export function EscalationsView({ run }: { run: string | null }) {
  const now = useNow();
  const list = useResource(
    run === null ? null : `esc:${run}`,
    (c, s) => c.escalations(run ?? "", s),
    run === null ? [] : [runTopic(run, "escalations")],
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: "Escalations" },
        ]}
      />
      <PageHeader
        title="Escalations"
        eyebrow="Read-only. The Lead batches these and asks you in its chat."
      />
      <Loaded resource={list}>
        {(data) =>
          data.escalations.length === 0 ? (
            <EmptyState
              icon={<MessageSquareText aria-hidden />}
              title="No escalations"
              description="Nothing is waiting for a human decision."
            />
          ) : (
            <div className="space-y-3">
              {sortEscalations(data.escalations).map((e) => (
                <EscalationCard key={e.id} escalation={e} now={now} />
              ))}
            </div>
          )
        }
      </Loaded>
    </>
  );
}
