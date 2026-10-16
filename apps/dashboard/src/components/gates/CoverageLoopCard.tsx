"use client";

import { OctagonAlert } from "lucide-react";
import { useId } from "react";
import { COVERAGE_ESCALATION_OPTIONS, type CoverageLoopView } from "@/lib/design-coverage";
import { hrefs } from "@/lib/router";
import { formatLocalTime } from "@/lib/time";
import { useNow } from "@/lib/useNow";
import { Link } from "@/components/app/Link";
import { Stat } from "@/components/flows/DrawerParts";
import { Card, CardDescription, CardHeader, CardTitle, StatusPill } from "@/components/ui";

const plural = (n: number, one: string): string => `${String(n)} ${one}${n === 1 ? "" : "s"}`;

const OPTIONS = Object.values(COVERAGE_ESCALATION_OPTIONS).join(", or ");

/** The parked loop's escalation: why, the REQs still uncovered and what the human can do. */
export function CoverageParked({ run, loop }: { run: string; loop: CoverageLoopView }) {
  if (loop.park === null) return null;
  const { answered } = loop.park;
  return (
    <div
      role={answered ? undefined : "alert"}
      className={
        answered
          ? "flex gap-2 rounded-2xl border border-border px-3 py-2 text-sm"
          : "flex gap-2 rounded-2xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
      }
      data-testid="coverage-parked"
    >
      <OctagonAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
      <div className="space-y-1">
        <p className="font-medium">The run parked before G2: {loop.park.reason}</p>
        {loop.uncovered.length === 0 ? null : <p>Uncovered: {loop.uncovered.join(", ")}</p>}
        <p className="text-xs text-muted-fg">
          {answered
            ? "The human answered in the Lead chat; the run goes on from that answer."
            : `In the Lead chat, ${OPTIONS}.`}
        </p>
        <Link className="text-xs text-accent-fg underline" href={hrefs.escalations(run)}>
          {loop.park.escalation === null ? "See escalations" : `Escalation ${loop.park.escalation}`}
        </Link>
      </div>
    </div>
  );
}

/**
 * The G2 coverage loop (H-13; spine §5 reading 237), shown before G2: the newest check, the fix
 * rounds used, the roles re-dispatched and the gaps they fix, and where it parked. G2 is asked
 * only after a complete check: there is no "approve anyway".
 */
export function CoverageLoopCard({ run, loop }: { run: string; loop: CoverageLoopView }) {
  const now = useNow();
  const base = useId();
  return (
    <Card aria-labelledby={`${base}-title`} data-testid="coverage-loop">
      <CardHeader>
        <div>
          <CardTitle id={`${base}-title`}>Design coverage before G2</CardTitle>
          <CardDescription>{loop.headline}</CardDescription>
        </div>
        <StatusPill meta={loop.state} />
      </CardHeader>
      <div className="space-y-4">
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Stat label="Check">{loop.check}</Stat>
          <Stat label="Fix rounds">{loop.fixRounds}</Stat>
          <Stat label="Re-dispatched">
            {loop.redispatched.length === 0 ? "—" : loop.redispatched.join(", ")}
          </Stat>
        </dl>
        <CoverageParked run={run} loop={loop} />
        {loop.gaps.length === 0 && loop.screensProblem === null ? null : (
          <div className="grid gap-3 md:grid-cols-2">
            {loop.gaps.map((g) => (
              <section key={g.id} className="space-y-1">
                <h3 className="text-xs font-semibold tracking-wide text-muted-fg uppercase">
                  {g.label}
                </h3>
                <ul aria-label={g.label} className="list-disc pl-5 text-sm">
                  {g.items.map((item) => (
                    <li key={item} className="font-mono">
                      {item}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
            {loop.screensProblem === null ? null : (
              <p className="text-sm">
                <span className="font-medium">screens.yaml:</span> {loop.screensProblem}
              </p>
            )}
          </div>
        )}
        {loop.checks.length < 2 ? null : (
          <ol
            aria-label="Coverage checks"
            className="space-y-1 border-l border-border pl-3 text-xs"
          >
            {loop.checks.map((c) => (
              <li key={c.seq} className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">Check {c.check}</span>
                <StatusPill meta={c.outcome} />
                <span className="text-muted-fg">{plural(c.gaps, "gap")}</span>
                <time className="text-muted-fg" dateTime={c.at}>
                  {formatLocalTime(c.at, now)}
                </time>
              </li>
            ))}
          </ol>
        )}
        <p className="text-xs text-muted-fg">
          G2 is asked only once every requirement is covered; the engine re-dispatches the Architect
          and the Designer with the gaps first, up to {loop.maxRounds} fix rounds.
        </p>
      </div>
    </Card>
  );
}
