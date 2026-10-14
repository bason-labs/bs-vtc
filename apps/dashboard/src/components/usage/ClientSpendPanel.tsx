"use client";

import type { ClientSpendReport } from "@vtc/shared";
import { clientSpendModel } from "@/lib/spend";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui";

/** Cost per client (§14): every project of this project's client, from each run's recorded end. */
export function ClientSpendPanel({ report }: { report: ClientSpendReport }) {
  const now = useNow();
  const model = clientSpendModel(report);
  return (
    <Card data-testid="client-spend" aria-labelledby="client-spend-title">
      <CardHeader>
        <div>
          <CardTitle id="client-spend-title">{model.title}</CardTitle>
          <CardDescription>
            List-price-equivalent spend of finished runs, per project of this client
          </CardDescription>
        </div>
        <span className="tabular font-display text-lg font-semibold">{model.total}</span>
      </CardHeader>
      {model.projects.length === 0 ? (
        <p className="text-sm text-muted-fg">No run of this client has finished yet.</p>
      ) : (
        <ul className="divide-y divide-border">
          {model.projects.map((p) => (
            <li key={p.key} className="flex flex-wrap items-baseline justify-between gap-x-3 py-2">
              <span className="font-medium">{p.name}</span>
              <span className="tabular text-sm">
                {p.spent}
                <span className="text-muted-fg">
                  {" "}
                  · {p.runs} · last {formatLocalTime(p.lastFinishedAt, now)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {model.unpriced === null ? null : (
        <p className="mt-3 text-sm text-warn-fg">{model.unpriced}</p>
      )}
    </Card>
  );
}
