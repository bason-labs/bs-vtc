"use client";

import { useResource } from "@/lib/useResource";
import { UsagePanel } from "@/components/usage/UsagePanel";
import { Loaded, PageHeader } from "./common";

/** Per-host usage (§6.9, §17 usage panel). */
export function UsageView() {
  const usage = useResource("usage", (c, s) => c.usage(s), ["usage"]);
  return (
    <>
      <PageHeader title="Usage" eyebrow="5-hour and weekly windows per host, in your local time" />
      <Loaded resource={usage} skeleton="h-48">
        {(report) => <UsagePanel report={report} />}
      </Loaded>
    </>
  );
}
