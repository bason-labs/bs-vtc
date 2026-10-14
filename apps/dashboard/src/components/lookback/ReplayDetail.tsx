"use client";

import { useId } from "react";
import type { ReplayResult } from "@vtc/shared";
import { describeError } from "@/lib/api/errors";
import { isReplayPath, readReplayResult, replayView } from "@/lib/replays";
import { useResource } from "@/lib/useResource";
import { StatusPill } from "@/components/ui";

/**
 * One Lookback replay (§13 step 3): the verdict, which grader scored it (`ReplayResult.grader`,
 * D-ch), both arms per replayed task, the sign test, the A/A flip rate, tokens and isolation, and
 * what a verdict `improve` leads to (D-cb). `ordinals` shows tasks as `task n` (upstream mode).
 */
export function ReplayDetail({
  replay,
  ordinals = false,
}: {
  replay: ReplayResult;
  ordinals?: boolean;
}) {
  const view = replayView(replay, { ordinals });
  const id = useId();
  return (
    <div className="space-y-3" data-testid="replay">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          Replay of <span className="font-mono">{view.proposal}</span> · {view.target}
        </span>
        <StatusPill meta={view.verdict} />
      </p>
      <p role="note" aria-label="Grader" className="text-xs">
        <span className="font-medium">{view.grader.label}.</span>{" "}
        <span className="text-muted-fg">{view.grader.detail}</span>
      </p>
      {view.next === null ? null : (
        <p role="note" aria-label="What happens next" className="text-xs text-ok">
          {view.next}
        </p>
      )}
      <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
        {view.stats.map(([label, value]) => (
          <div key={label} className="min-w-0 rounded-xl bg-surface-2 p-2">
            <dt className="text-[11px] text-muted-fg">{label}</dt>
            <dd className="font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <table className="w-full text-left text-xs" aria-labelledby={id}>
        <caption id={id} className="mb-1 text-left text-xs font-semibold">
          Arms per replayed task
        </caption>
        <thead className="text-muted-fg">
          <tr>
            <th scope="col" className="py-1 pr-2 font-medium">
              Task
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Baseline (a)
            </th>
            <th scope="col" className="py-1 pr-2 font-medium">
              Candidate (b)
            </th>
            <th scope="col" className="py-1 font-medium">
              Regression set
            </th>
          </tr>
        </thead>
        <tbody className="tabular">
          {view.tasks.map((t) => (
            <tr key={t.label} className="border-t border-border/60">
              <th scope="row" className="py-1 pr-2 font-mono font-normal">
                {t.label}
              </th>
              <td className="py-1 pr-2">{t.baseline}</td>
              <td className="py-1 pr-2">{t.candidate}</td>
              <td className="py-1">{t.regression ? "yes" : "no"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The replay result at `path` (a `lookback.replay_finished` event names it), read through the
 * artifacts route; only a path under the replays directory is read.
 */
export function ReplayResultAt({
  run,
  path,
  ordinals = false,
}: {
  run: string;
  path: string;
  ordinals?: boolean;
}) {
  const valid = isReplayPath(path);
  const artifact = useResource(valid ? `artifact:${run}:${path}` : null, (c, s) =>
    c.artifact(run, path, s),
  );
  if (!valid) return null;
  if (artifact.data === undefined) {
    return artifact.error === null ? (
      <p className="text-xs text-muted-fg" role="status">
        Loading the replay…
      </p>
    ) : (
      <p className="text-xs text-danger">
        The replay result could not be read: {describeError(artifact.error)}
      </p>
    );
  }
  const read = readReplayResult(artifact.data);
  return read.ok ? (
    <ReplayDetail replay={read.value} ordinals={ordinals} />
  ) : (
    <p className="text-xs text-danger">
      This replay result breaks its contract and is not shown: {read.problem}
    </p>
  );
}
