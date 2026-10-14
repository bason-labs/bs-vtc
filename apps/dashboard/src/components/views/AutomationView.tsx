"use client";

import { ExternalLink, Info } from "lucide-react";
import {
  automationView,
  type AutomationLink,
  type AutomationView as Model,
} from "@/lib/automation";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusPill,
} from "@/components/ui";
import { Loaded, PageHeader } from "./common";
import { REDACT } from "@/lib/redact";

function LinkTo({ link }: { link: AutomationLink }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {link.href === null ? (
        <span className="font-medium">{link.label}</span>
      ) : (
        <a
          className="inline-flex items-center gap-1 font-medium text-accent-fg underline"
          href={link.href}
          target="_blank"
          rel="noopener noreferrer"
        >
          {link.label}
          <ExternalLink aria-hidden className="size-3" />
        </a>
      )}
      <StatusPill meta={link.state} />
    </span>
  );
}

function Status({ model }: { model: Model }) {
  return (
    <Card aria-labelledby="automation-status">
      <CardHeader>
        <div>
          <CardTitle id="automation-status">
            {model.off ? "Automation is off for this project" : "Automation is on"}
          </CardTitle>
          <CardDescription>Evidence for automatic PRs is {model.hosting}.</CardDescription>
        </div>
      </CardHeader>
      <ul aria-label="Automation switches" className="flex flex-wrap gap-2">
        {model.switches.map((s) => (
          <li key={s.id} data-testid={`switch-${s.id}`}>
            <Badge tone={s.on ? "ok" : "neutral"}>
              {s.label}: {s.on ? "on" : "off"}
            </Badge>
          </li>
        ))}
      </ul>
      {model.notes.length === 0 ? null : (
        <ul aria-label="Automation notes" className="mt-3 space-y-1">
          {model.notes.map((n) => (
            <li key={n} role="note" className="flex gap-1.5 text-xs text-muted-fg">
              <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>{n}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Items({ model, now }: { model: Model; now: number }) {
  return (
    <Card aria-labelledby="automation-items">
      <CardHeader>
        <div>
          <CardTitle id="automation-items">Issues and pull requests VTC opened</CardTitle>
          <CardDescription>
            Newest first. VTC never merges them: a human reviews and merges every automatic PR.
          </CardDescription>
        </div>
      </CardHeader>
      {model.items.length === 0 ? (
        <EmptyState title="Nothing opened yet" />
      ) : (
        <ul aria-label="Automatic issues and PRs" className="space-y-2">
          {model.items.map((i) => (
            <li
              key={i.key}
              data-testid={`automation-item-${i.fingerprint}`}
              className="rounded-2xl border border-border bg-surface/60 px-3 py-2 text-sm"
            >
              <p className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{i.kind}</span>
                <span className="text-xs text-muted-fg">{i.target}</span>
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
                {i.issue === null ? (
                  <span className="text-muted-fg">No issue</span>
                ) : (
                  <LinkTo link={i.issue} />
                )}
                {i.pr === null ? (
                  <span className="text-muted-fg">No pull request</span>
                ) : (
                  <span className="inline-flex flex-wrap items-center gap-1.5">
                    <LinkTo link={i.pr} />
                    <StatusPill meta={i.pr.evidence} />
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-muted-fg">
                First seen <time dateTime={i.first}>{formatLocalTime(i.first, now)}</time>, last
                seen <time dateTime={i.last}>{formatLocalTime(i.last, now)}</time>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Skipped({ model, now }: { model: Model; now: number }) {
  if (model.skipped.length === 0) return null;
  return (
    <Card aria-labelledby="automation-skipped">
      <CardHeader>
        <div>
          <CardTitle id="automation-skipped">Not raised</CardTitle>
          <CardDescription>The latest automatic actions VTC did not take, and why.</CardDescription>
        </div>
      </CardHeader>
      <ol
        aria-label="Skipped automatic actions"
        className="space-y-1.5 border-l border-border pl-3"
      >
        {model.skipped.map((s) => (
          <li key={s.key} className="text-sm">
            <p className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{s.reason}</span>
              {s.kind === null ? null : <Badge tone="neutral">{s.kind}</Badge>}
              <time className="text-xs text-muted-fg" dateTime={s.at}>
                {formatLocalTime(s.at, now)}
              </time>
            </p>
            <p className="text-xs break-words text-muted-fg" {...REDACT}>
              {s.detail}
            </p>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/**
 * Automation (D-ca, spine AD-27 rule 7): whether VTC raises issues and opens PRs for this
 * project (and why not), the issues and PRs it opened with links and state, and the actions it
 * skipped with the reason (`GET /api/automation`).
 */
export function AutomationView() {
  const now = useNow();
  const report = useResource("automation", (c, s) => c.automation(s), ["automation"]);
  return (
    <>
      <PageHeader
        title="Automation"
        eyebrow="Issues and pull requests VTC raises on its own, for human review"
      />
      <Loaded
        resource={report}
        missing={
          <EmptyState
            title="No automation report"
            description="This engine reports no automatic issues or pull requests (an older engine)."
          />
        }
      >
        {(r) => {
          const model = automationView(r);
          return (
            <div className="space-y-4">
              <Status model={model} />
              <Items model={model} now={now} />
              <Skipped model={model} now={now} />
            </div>
          );
        }}
      </Loaded>
    </>
  );
}
