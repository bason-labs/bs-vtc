"use client";

import type { UsageReport } from "@vtc/shared";
import { Clock, PauseCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import type { AgeTone } from "@/lib/time";
import { usagePanelModel, type UsageCardModel, type UsageTone } from "@/lib/usage";
import { useNow } from "@/lib/useNow";
import { Badge, Card, CardDescription, CardHeader, CardTitle, ProgressBar } from "@/components/ui";

const AGE_TONE: Readonly<Record<AgeTone, "ok" | "warn" | "danger" | "neutral">> = {
  fresh: "ok",
  stale: "warn",
  old: "danger",
  never: "neutral",
};

const BAR_TONE: Readonly<Record<UsageTone, "brand" | "warn" | "danger">> = {
  ok: "brand",
  warn: "warn",
  danger: "danger",
  unknown: "brand",
};

/** One host's usage card (§17 usage panel, D15). */
export function UsageCard({ card }: { card: UsageCardModel }) {
  return (
    <Card data-testid={`usage-${card.host}`} aria-labelledby={`usage-title-${card.host}`}>
      <CardHeader>
        <div>
          <CardTitle id={`usage-title-${card.host}`}>{card.name}</CardTitle>
          <CardDescription>{card.sourceText}</CardDescription>
        </div>
        <Badge tone={AGE_TONE[card.updated.tone]}>
          <Clock aria-hidden className="size-3" />
          {card.updated.text}
        </Badge>
      </CardHeader>
      <ul className="space-y-4">
        {card.windows.map((w) => (
          <li key={w.key} className="space-y-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 text-sm">
              <span className="font-medium">{w.title}</span>
              <span
                className={cn(
                  "tabular",
                  w.usedPct === null ? "text-muted-fg italic" : "font-medium",
                )}
              >
                {w.usedText}
                {w.usedPct === null ? null : (
                  <span className="font-normal text-muted-fg"> · {w.remainingText}</span>
                )}
              </span>
            </div>
            <ProgressBar
              value={w.usedPct}
              tone={BAR_TONE[w.tone]}
              label={`${card.name} ${w.title} used`}
            />
            <p className="text-xs text-muted-fg">{w.resetText}</p>
          </li>
        ))}
      </ul>
      {card.modelLimits.length === 0 ? null : (
        <ul
          className="mt-4 space-y-1 border-t border-border/60 pt-3 text-xs"
          aria-label="Per-model limits"
        >
          {card.modelLimits.map((m) => (
            <li key={m} className="text-warn-fg">
              {m}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** The usage panel: one card per host, the interrupted tasks and the auto-resume countdown. */
export function UsagePanel({ report }: { report: UsageReport }) {
  const now = useNow(15_000);
  const model = usagePanelModel(report, now);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        {model.cards.map((card) => (
          <UsageCard key={card.host} card={card} />
        ))}
      </div>
      <p
        className="flex flex-wrap items-center gap-2 text-xs text-muted-fg"
        data-testid="usage-interrupted"
      >
        <PauseCircle aria-hidden className="size-3.5" />
        {model.interrupted.count === 0
          ? "No tasks interrupted by usage limits."
          : `${String(model.interrupted.count)} task${model.interrupted.count === 1 ? "" : "s"} interrupted by usage limits (${model.interrupted.tasks.join(", ")}).`}
        <span>{model.autoResume ?? "No auto-resume scheduled."}</span>
      </p>
    </div>
  );
}
