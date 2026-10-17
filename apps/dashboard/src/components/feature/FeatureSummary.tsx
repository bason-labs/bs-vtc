import type { Feature, Task } from "@vtc/shared";
import type { ReactNode } from "react";
import { Check, ExternalLink, GitPullRequest } from "lucide-react";
import { cn } from "@/lib/cn";
import { finalReviewSteps, pullRequestModel } from "@/lib/feature";
import { hrefs } from "@/lib/router";
import { featureStatusMeta, taskStatusMeta } from "@/lib/states";
import { Link } from "@/components/app/Link";
import {
  Badge,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  ProgressBar,
  StatusPill,
} from "@/components/ui";

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Final Review state (§6.7a) as a stepper: building → integrating → final review ⇄ fixing → ready → shipped. */
export function FinalReviewTracker({ feature }: { feature: Feature }) {
  const model = finalReviewSteps(feature);
  return (
    <div className="space-y-3">
      {model.parked === null ? null : (
        <p
          role="status"
          className="rounded-xl border border-danger/40 bg-danger/5 px-3 py-2 text-sm text-danger"
        >
          {model.parked}. The Lead asks the human; unrelated features keep running.
        </p>
      )}
      <ol aria-label="Feature progress" className="grid gap-2 sm:grid-cols-5">
        {model.steps.map((s, i) => (
          <li
            key={s.key}
            aria-current={s.state === "current" ? "step" : undefined}
            className={cn(
              "flex items-center gap-2 rounded-2xl border px-3 py-2 text-sm",
              s.state === "done" && "border-ok/40 bg-ok/5",
              s.state === "current" && "border-accent bg-accent/10 font-medium",
              s.state === "todo" && "border-dashed border-border text-muted-fg",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full text-[11px] tabular",
                s.state === "done"
                  ? "bg-ok text-white"
                  : s.state === "current"
                    ? "bg-brand text-white"
                    : "bg-surface-3",
              )}
            >
              {s.state === "done" ? <Check className="size-3" /> : i + 1}
            </span>
            <span>{s.label}</span>
            <span className="sr-only">({s.state})</span>
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-fg">
        Final Review round {model.round} (cap 3; re-runs only the steps a fix touched, plus the full
        gates).
      </p>
    </div>
  );
}

/** The feature's PR as the engine last saw it (§6.7): draft until Final Review passes. */
export function PullRequestCard({ feature }: { feature: Feature }) {
  if (feature.pr === undefined) {
    return (
      <Card aria-label="Pull request">
        <CardHeader>
          <CardTitle>Pull request</CardTitle>
        </CardHeader>
        <p className="text-sm text-muted-fg">
          No PR yet. At merge level 2 the engine opens a draft PR for{" "}
          <code className="font-mono">{feature.integration_branch}</code> once the branch is pushed;
          it is marked ready only after Final Review passes.
        </p>
      </Card>
    );
  }
  const pr = pullRequestModel(feature.pr);
  return (
    <Card aria-label="Pull request" data-testid="pull-request">
      <CardHeader>
        <CardTitle>Pull request</CardTitle>
        <div className="flex gap-1.5">
          <Badge tone={pr.stateTone}>
            <GitPullRequest aria-hidden className="size-3" /> {pr.stateLabel}
          </Badge>
          <Badge tone={pr.ciTone}>{pr.ciLabel}</Badge>
        </div>
      </CardHeader>
      {pr.url === null ? (
        <p className="text-sm text-muted-fg">The PR address is not a web link.</p>
      ) : (
        <a
          className="inline-flex items-center gap-1 text-sm break-all text-accent-fg underline"
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          {pr.url} <ExternalLink aria-hidden className="size-3.5 shrink-0" />
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      )}
      {pr.autoMerge === null && pr.mergeState === null ? null : (
        <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
          {pr.autoMerge === null ? null : <StatusPill meta={pr.autoMerge} />}
          {pr.mergeState === null ? null : (
            <span className="text-muted-fg">
              GitHub merge state <span className="font-mono">{pr.mergeState}</span>
            </span>
          )}
        </p>
      )}
      {pr.requiredChecks.length === 0 ? null : (
        <ul aria-label="Required checks" className="mt-2 space-y-1 text-xs">
          {pr.requiredChecks.map((c) => (
            <li key={c.name} className="flex items-center justify-between gap-2">
              <span className="font-mono break-all">{c.name}</span>
              <StatusPill meta={c.status} />
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-muted-fg">
        {pr.number === null ? null : <>PR {pr.number} · </>}
        Head <span className="font-mono">{pr.head}</span>
        {pr.mergeCommit === null ? null : (
          <>
            {" "}
            · merged as <span className="font-mono">{pr.mergeCommit}</span>
          </>
        )}
      </p>
    </Card>
  );
}

/** Feature header, budget and PR, then `children` (Final Review steps, Level 3), then its tasks. */
export function FeatureSummary({
  run,
  feature,
  tasks,
  children,
}: {
  run: string;
  feature: Feature;
  tasks: readonly Task[];
  children?: ReactNode;
}) {
  const spentPct = feature.budget_usd === 0 ? 0 : (feature.spent_usd / feature.budget_usd) * 100;
  const own = tasks.filter((t) => feature.tasks.includes(t.id));
  return (
    <div className="space-y-4">
      <Card aria-labelledby="feature-title">
        <CardHeader>
          <div>
            <p className="text-xs text-muted-fg">
              {feature.id} · <code className="font-mono">{feature.integration_branch}</code>
            </p>
            <h1 id="feature-title" className="font-display text-xl font-semibold">
              {feature.title}
            </h1>
          </div>
          <StatusPill meta={featureStatusMeta(feature)} />
        </CardHeader>
        <FinalReviewTracker feature={feature} />
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card aria-labelledby="budget-title">
          <CardHeader>
            <CardTitle id="budget-title">Budget</CardTitle>
            <CardDescription className="tabular">
              {usd(feature.spent_usd)} of {usd(feature.budget_usd)}
            </CardDescription>
          </CardHeader>
          <ProgressBar
            value={spentPct}
            tone={spentPct >= 90 ? "danger" : spentPct >= 75 ? "warn" : "brand"}
            label="Feature budget spent"
          />
          <p className="mt-2 text-xs text-muted-fg tabular">
            Final Review budget line: {usd(feature.final_review_budget_usd)}
          </p>
        </Card>
        <PullRequestCard feature={feature} />
      </div>

      {children}

      <Card aria-labelledby="tasks-title">
        <CardHeader>
          <CardTitle id="tasks-title">Tasks</CardTitle>
          <CardDescription>{feature.tasks.length} in this feature</CardDescription>
        </CardHeader>
        <ul className="divide-y divide-border/60">
          {own.map((t) => (
            <li
              key={t.id}
              className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
            >
              <Link
                className="min-w-0 font-medium text-accent-fg underline"
                href={hrefs.task(run, t.id)}
              >
                {t.id} {t.title}
              </Link>
              <span className="flex items-center gap-2 text-xs text-muted-fg">
                <span className="tabular">
                  round {t.round}/{t.cap}
                </span>
                <StatusPill meta={taskStatusMeta(t)} />
              </span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
