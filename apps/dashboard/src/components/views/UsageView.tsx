"use client";

import { useResource } from "@/lib/useResource";
import { ClientSpendPanel } from "@/components/usage/ClientSpendPanel";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { Loaded, PageHeader } from "./common";

/** Per-host usage (§6.9, §17 usage panel) and cost per client (§14). */
export function UsageView() {
  const usage = useResource("usage", (c, s) => c.usage(s), ["usage"]);
  const spend = useResource("client-spend", (c, s) => c.clientSpend(s), ["runs"]);
  return (
    <>
      <PageHeader title="Usage" eyebrow="5-hour and weekly windows per host, in your local time" />
      <Loaded resource={usage} skeleton="h-48">
        {(report) => <UsagePanel report={report} />}
      </Loaded>
      <div className="mt-6">
        <Loaded
          resource={spend}
          skeleton="h-24"
          missing={
            <p className="text-sm text-muted-fg">
              No cost record to show: this dashboard reads none (an older engine, or no run has
              finished).
            </p>
          }
        >
          {(report) => <ClientSpendPanel report={report} />}
        </Loaded>
      </div>
    </>
  );
}
