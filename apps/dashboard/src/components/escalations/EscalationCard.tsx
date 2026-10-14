import type { Escalation } from "@vtc/shared";
import { CheckCircle2, CircleHelp, Star } from "lucide-react";
import { escalationModel } from "@/lib/escalations";
import { hrefs } from "@/lib/router";
import { formatLocalTime } from "@/lib/time";
import { Link } from "@/components/app/Link";
import { Badge, Card } from "@/components/ui";

/** One escalation (§6.5), read-only: the human answers in the Lead chat. */
export function EscalationCard({ escalation, now }: { escalation: Escalation; now: number }) {
  const m = escalationModel(escalation);
  const answered = m.answer !== null;
  return (
    <Card aria-labelledby={`esc-${m.id}`} data-testid={`escalation-${m.id}`}>
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Badge tone={answered ? "ok" : "warn"}>
          {answered ? (
            <CheckCircle2 aria-hidden className="size-3" />
          ) : (
            <CircleHelp aria-hidden className="size-3" />
          )}
          {answered ? "Answered" : "Open"}
        </Badge>
        <Badge>{m.id}</Badge>
        <Badge tone="danger">{m.reason}</Badge>
        <span className="text-muted-fg">
          {m.scope} · raised {formatLocalTime(m.createdAt, now)}
          {m.raisedBy === null ? "" : ` by ${m.raisedBy}`}
        </span>
      </div>
      <h2 id={`esc-${m.id}`} className="mt-2 font-display text-base font-semibold">
        {m.question}
      </h2>
      {m.detail === null ? null : <p className="mt-1 text-sm text-muted-fg">{m.detail}</p>}

      <h3 className="mt-3 text-xs font-semibold tracking-wide text-muted-fg uppercase">Options</h3>
      <ul className="mt-1 space-y-1.5">
        {m.options.map((o) => (
          <li
            key={o.id}
            className="flex flex-wrap items-center gap-2 rounded-xl border border-border px-3 py-2 text-sm"
          >
            <span className="font-medium">{o.label}</span>
            <span className="text-xs text-muted-fg">Effect: {o.effect}</span>
            {o.recommended ? (
              <Badge tone="brand">
                <Star aria-hidden className="size-3" /> Recommended
              </Badge>
            ) : null}
          </li>
        ))}
      </ul>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">Evidence</h3>
          <ul className="mt-1 space-y-1 font-mono text-xs break-all">
            {m.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">Blocks</h3>
          <p className="mt-1 text-sm">
            {m.blocks.length === 0
              ? "Nothing else"
              : m.blocks.map((t, i) => (
                  <span key={t}>
                    {i > 0 ? ", " : ""}
                    <Link className="text-accent-fg underline" href={hrefs.task(escalation.run, t)}>
                      {t}
                    </Link>
                  </span>
                ))}
          </p>
        </div>
      </div>

      {m.answer === null ? (
        <p className="mt-3 rounded-xl bg-surface-2 px-3 py-2 text-xs text-muted-fg">
          Read-only here. Answer it in the Lead chat; the Lead batches open questions.
        </p>
      ) : (
        <p className="mt-3 rounded-xl bg-ok/10 px-3 py-2 text-sm">
          Answered {formatLocalTime(m.answer.at, now)}: <b>{m.answer.option}</b>
          {m.answer.text === null ? "" : `: ${m.answer.text}`}{" "}
          <span className="text-xs text-muted-fg">
            (should have been caught by: {m.answer.caughtBy})
          </span>
        </p>
      )}
    </Card>
  );
}
