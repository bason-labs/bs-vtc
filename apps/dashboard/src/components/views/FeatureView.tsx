"use client";

import { useMemo } from "react";
import { runTopic } from "@/lib/api/topics";
import { featureLevel3, finalReviewStepRows, mergePreflight } from "@/lib/level3";
import { hrefs } from "@/lib/router";
import { useResource } from "@/lib/useResource";
import { useRunEvents } from "@/lib/useRunEvents";
import { FinalReviewStepsCard, Level3Card } from "@/components/feature/Level3";
import { FeatureSummary } from "@/components/feature/FeatureSummary";
import { RunNotices } from "@/components/notices/RunNotices";
import { EmptyState } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam } from "./common";

/**
 * The run's feature (§6.7a): Final Review state and steps, budget, PR (with Level 3's
 * auto-merge state and required checks), the Level-3 checklist and timeline, and tasks.
 */
export function FeatureView({ run, feature }: { run: string | null; feature: string | null }) {
  const key = run ?? "";
  const features = useResource(
    run === null ? null : `features:${key}`,
    (c, s) => c.features(key, s),
    run === null ? [] : [runTopic(key, "features")],
  );
  const tasks = useResource(
    run === null ? null : `tasks:${key}`,
    (c, s) => c.tasks(key, s),
    run === null ? [] : [runTopic(key, "tasks")],
  );
  const events = useRunEvents(run, ["level3"]);
  const preflight = useMemo(
    () => (events.data === undefined ? null : mergePreflight(events.data)),
    [events.data],
  );
  if (run === null) return <MissingParam what="run" />;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run) },
          { label: "Feature" },
        ]}
      />
      <div className="mt-3">
        <Loaded resource={features}>
          {(data) => {
            const chosen =
              feature === null ? data.features[0] : data.features.find((f) => f.id === feature);
            if (chosen === undefined) {
              return (
                <EmptyState
                  title={feature === null ? "No feature yet" : `No feature ${feature}`}
                  description="The engine creates the run's feature at PLAN, right after the Planner's tasks."
                />
              );
            }
            return (
              <>
                <RunNotices run={run} feature={chosen.id} />
                <FeatureSummary run={run} feature={chosen} tasks={tasks.data?.tasks ?? []}>
                  {events.data === undefined ? null : (
                    <>
                      <FinalReviewStepsCard rows={finalReviewStepRows(events.data, chosen.id)} />
                      <Level3Card
                        preflight={preflight}
                        {...featureLevel3(events.data, chosen.id)}
                      />
                    </>
                  )}
                </FeatureSummary>
              </>
            );
          }}
        </Loaded>
      </div>
    </>
  );
}
