"use client";

import { LOOKBACK_REPO } from "@vtc/shared";
import { FileText } from "lucide-react";
import { useMemo } from "react";
import { runTopic } from "@/lib/api/topics";
import { describeError } from "@/lib/api/errors";
import { hrefs } from "@/lib/router";
import {
  groupScorecards,
  lookbackActivity,
  readScorecard,
  readScorecardIndex,
  type ScorecardGroup,
} from "@/lib/scorecards";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { useRunEvents } from "@/lib/useRunEvents";
import { Link } from "@/components/app/Link";
import { ScorecardDetail } from "@/components/lookback/ScorecardDetail";
import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  EmptyState,
  StatusPill,
} from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

function ScorecardCard({ run, group }: { run: string; group: ScorecardGroup }) {
  const now = useNow();
  const [latest, ...older] = group.versions;
  const path = latest?.path ?? "";
  const card = useResource(
    latest === undefined ? null : `artifact:${run}:${path}`,
    (c, s) => c.artifact(run, path, s),
    [runTopic(run, "lookback")],
  );
  const read = card.data === undefined ? null : readScorecard(card.data);
  return (
    <Card aria-labelledby={`sc-${group.key}`} data-testid={`scorecard-group-${group.key}`}>
      <CardHeader>
        <div>
          <CardTitle id={`sc-${group.key}`}>{group.title}</CardTitle>
          {latest === undefined ? null : (
            <CardDescription>
              Version <span className="font-mono">{latest.version}</span> · written{" "}
              {formatLocalTime(latest.writtenAt, now)}
            </CardDescription>
          )}
        </div>
        <Link
          className="inline-flex items-center gap-1 text-xs text-accent-fg underline"
          href={hrefs.artifact(run, path)}
        >
          <FileText aria-hidden className="size-3.5" /> scorecard.json
        </Link>
      </CardHeader>
      {card.error !== null && card.data === undefined ? (
        <p className="text-sm text-danger">{describeError(card.error)}</p>
      ) : read === null ? (
        <p className="text-sm text-muted-fg" role="status">
          Loading…
        </p>
      ) : read.ok ? (
        <ScorecardDetail scorecard={read.value} />
      ) : (
        <p className="text-sm text-danger">
          This scorecard breaks its contract and is not shown: {read.problem}
        </p>
      )}
      {older.length === 0 ? null : (
        <details className="mt-3 text-xs">
          <summary className="cursor-pointer font-medium">
            {older.length} earlier {older.length === 1 ? "version" : "versions"}
          </summary>
          <ul className="mt-1 space-y-1">
            {older.map((v) => (
              <li key={v.path}>
                <Link
                  className="font-mono text-accent-fg underline"
                  href={hrefs.artifact(run, v.path)}
                >
                  {v.version}
                </Link>{" "}
                <span className="text-muted-fg">written {formatLocalTime(v.writtenAt, now)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function Activity({ run }: { run: string }) {
  const now = useNow();
  const events = useRunEvents(run, ["lookback"]);
  const activity = useMemo(
    () => (events.data === undefined ? null : lookbackActivity(events.data)),
    [events.data],
  );
  if (activity === null || (activity.canaries.length === 0 && activity.items.length === 0)) {
    return null;
  }
  return (
    <Card aria-labelledby="lookback-activity">
      <CardHeader>
        <div>
          <CardTitle id="lookback-activity">In this run</CardTitle>
          <CardDescription>
            Proposals, replays and canaries. Only a human promotes a prompt version.
          </CardDescription>
        </div>
      </CardHeader>
      {activity.canaries.length === 0 ? null : (
        <ul aria-label="Canaries" className="mb-3 space-y-2">
          {activity.canaries.map((c) => (
            <li key={c.target} className="rounded-2xl border border-border px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">canary</Badge>
                <span className="font-medium">{c.target}</span>
                <StatusPill meta={c.verdict} />
              </p>
              <p className="mt-0.5 text-xs text-muted-fg">{c.reason}</p>
              <ul className="mt-0.5 text-xs tabular">
                {c.arms.map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {activity.items.length === 0 ? null : (
        <ol
          aria-label="Lookback events"
          className="space-y-1.5 border-l border-border pl-3 text-sm"
        >
          {activity.items.map((i) => (
            <li key={i.seq} data-type={i.type}>
              <p className="flex flex-wrap items-center gap-2">
                <StatusPill meta={{ label: i.title, tone: i.tone }} />
                <time className="text-xs text-muted-fg" dateTime={i.at}>
                  {formatLocalTime(i.at, now)}
                </time>
              </p>
              {i.detail === null ? null : <p className="text-xs text-muted-fg">{i.detail}</p>}
              {i.path === null ? null : (
                <Link
                  className="font-mono text-xs break-all text-accent-fg underline"
                  href={hrefs.artifact(run, i.path)}
                >
                  {i.path}
                </Link>
              )}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * Lookback (§13, AD-21): scorecards per prompt version from
 * `.vtc/lookback/scorecards/index.json`, every proportion with n and its interval, and the run's
 * lookback events (canaries, replays, proposals, rollbacks, escaped defects).
 */
export function LookbackView({ run }: { run: string | null }) {
  const key = run ?? "";
  const index = useResource(
    run === null ? null : `artifact:${key}:${LOOKBACK_REPO.scorecardIndex}`,
    (c, s) => c.artifact(key, LOOKBACK_REPO.scorecardIndex, s),
    run === null ? [] : [runTopic(key, "lookback")],
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: "Lookback" },
        ]}
      />
      <PageHeader title="Lookback" eyebrow="Scorecards per prompt version" />
      <div className="space-y-4">
        <Activity run={run} />
        <Loaded
          resource={index}
          missing={
            <EmptyState
              title="No scorecards yet"
              description="The engine scores each prompt version from finished runs and writes the scorecards to .vtc/lookback/scorecards/."
            />
          }
        >
          {(artifact) => {
            const read = readScorecardIndex(artifact);
            if (!read.ok) {
              return (
                <EmptyState
                  title="The scorecard index breaks its contract"
                  description={`Nothing is shown from it: ${read.problem}`}
                />
              );
            }
            const groups = groupScorecards(read.value);
            return groups.length === 0 ? (
              <EmptyState title="No scorecards yet" />
            ) : (
              <div className="space-y-4">
                {groups.map((g) => (
                  <ScorecardCard key={g.key} run={run} group={g} />
                ))}
              </div>
            );
          }}
        </Loaded>
      </div>
    </>
  );
}
