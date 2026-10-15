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
  refusedScorecardPaths,
  type ScorecardGroup,
} from "@/lib/scorecards";
import { formatLocalTime } from "@/lib/time";
import { useEvidenceMode } from "@/lib/useEvidenceMode";
import { useNow } from "@/lib/useNow";
import { useResource } from "@/lib/useResource";
import { useRunEvents } from "@/lib/useRunEvents";
import { Link } from "@/components/app/Link";
import { ReplayResultAt } from "@/components/lookback/ReplayDetail";
import { RoutingScorecardCard } from "@/components/lookback/RoutingScorecard";
import { ScorecardDetail } from "@/components/lookback/ScorecardDetail";
import { EventLogTruncated } from "@/components/notices/EventLogTruncated";
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

function ScorecardCard({
  run,
  group,
  upstream,
}: {
  run: string;
  group: ScorecardGroup;
  upstream: boolean;
}) {
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
        {upstream ? null : (
          <Link
            className="inline-flex items-center gap-1 text-xs text-accent-fg underline"
            href={hrefs.artifact(run, path)}
          >
            <FileText aria-hidden className="size-3.5" /> scorecard.json
          </Link>
        )}
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
                {upstream ? (
                  <span className="font-mono">{v.version}</span>
                ) : (
                  <Link
                    className="font-mono text-accent-fg underline"
                    href={hrefs.artifact(run, v.path)}
                  >
                    {v.version}
                  </Link>
                )}{" "}
                <span className="text-muted-fg">written {formatLocalTime(v.writtenAt, now)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </Card>
  );
}

function Activity({ run, upstream }: { run: string; upstream: boolean }) {
  const now = useNow();
  const events = useRunEvents(run, ["lookback"]);
  const activity = useMemo(() => {
    if (events.data === undefined) return null;
    const all = lookbackActivity(events.data.events);
    // Upstream evidence (D-by): replay arms and canary numbers only; no paths, commits or task ids.
    return upstream
      ? {
          canaries: all.canaries.map((c) => ({ ...c, reason: "" })),
          items: all.items
            .filter((i) => i.type === "lookback.replay_finished")
            .map((i) => ({ ...i, detail: null })),
        }
      : all;
  }, [events.data, upstream]);
  const truncated = events.data?.truncated === true;
  if (
    activity === null ||
    (activity.canaries.length === 0 && activity.items.length === 0 && !truncated)
  ) {
    return null;
  }
  return (
    <Card aria-labelledby="lookback-activity">
      <CardHeader>
        <div>
          <CardTitle id="lookback-activity">In this run</CardTitle>
          <CardDescription>
            Proposals, replays and canaries. Only a human promotes a prompt version: by merging the
            pull request VTC opens to its own repo (every user, next release), or with vtc lookback
            approve (a canary on this machine).
          </CardDescription>
        </div>
      </CardHeader>
      {truncated ? <EventLogTruncated className="mb-3" /> : null}
      {activity.canaries.length === 0 ? null : (
        <ul aria-label="Canaries" className="mb-3 space-y-2">
          {activity.canaries.map((c) => (
            <li key={c.target} className="rounded-2xl border border-border px-3 py-2 text-sm">
              <p className="flex flex-wrap items-center gap-1.5">
                <Badge tone="brand">canary</Badge>
                <span className="font-medium">{c.target}</span>
                <StatusPill meta={c.verdict} />
              </p>
              {c.reason === "" ? null : <p className="mt-0.5 text-xs text-muted-fg">{c.reason}</p>}
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
              {i.path === null || upstream ? null : (
                <Link
                  className="font-mono text-xs break-all text-accent-fg underline"
                  href={hrefs.artifact(run, i.path)}
                >
                  {i.path}
                </Link>
              )}
              {i.type === "lookback.replay_finished" && i.path !== null ? (
                <div className="mt-2 rounded-2xl border border-border p-3">
                  <ReplayResultAt run={run} path={i.path} ordinals={upstream} />
                </div>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </Card>
  );
}

/**
 * Lookback (§13, AD-21): scorecards per prompt version from
 * `.vtc/lookback/scorecards/index.json`, every proportion with n and its interval, the routing
 * scorecard (D-cn), and the run's lookback events (canaries, replays, proposals, rollbacks,
 * escaped defects). In upstream evidence mode only the scorecards, the routing scorecard, the
 * canaries' numbers and the replay arms (tasks as ordinals).
 */
export function LookbackView({ run }: { run: string | null }) {
  const key = run ?? "";
  const upstream = useEvidenceMode() === "upstream";
  const index = useResource(
    run === null ? null : `artifact:${key}:${LOOKBACK_REPO.scorecardIndex}`,
    (c, s) => c.artifact(key, LOOKBACK_REPO.scorecardIndex, s),
    run === null ? [] : [runTopic(key, "lookback")],
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      {upstream ? null : (
        <Breadcrumbs
          items={[
            { label: "Runs", href: hrefs.runs() },
            { label: run, href: hrefs.run(run) },
            { label: "Lookback" },
          ]}
        />
      )}
      <PageHeader title="Lookback" eyebrow="Scorecards per prompt version" />
      <div className="space-y-4">
        <Activity run={run} upstream={upstream} />
        <RoutingScorecardCard run={run} upstream={upstream} />
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
            const refused = refusedScorecardPaths(read.value);
            return (
              <div className="space-y-4">
                {refused.length === 0 || upstream ? null : (
                  <p role="alert" className="text-xs text-warn-fg" data-testid="scorecards-refused">
                    The scorecard index breaks its contract: not shown, because{" "}
                    {refused.length === 1 ? "this path is" : "these paths are"} outside{" "}
                    <code className="font-mono">{LOOKBACK_REPO.scorecardsDir}/</code>:{" "}
                    <span className="font-mono break-all">{refused.join(", ")}</span>
                  </p>
                )}
                {groups.length === 0 ? (
                  <EmptyState title="No scorecards yet" />
                ) : (
                  groups.map((g) => (
                    <ScorecardCard key={g.key} run={run} group={g} upstream={upstream} />
                  ))
                )}
              </div>
            );
          }}
        </Loaded>
      </div>
    </>
  );
}
