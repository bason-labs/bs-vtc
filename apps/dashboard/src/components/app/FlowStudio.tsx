"use client";

import { useEffect, useRef } from "react";
import { useRoute } from "@/lib/useRoute";
import type { RunZoom } from "@/lib/router";
import { ThemeProvider } from "@/components/theme/ThemeProvider";
import { AppShell } from "@/components/shell/AppShell";
import { ArtifactView } from "@/components/views/ArtifactView";
import { DesignReviewView } from "@/components/views/DesignReviewView";
import { EscalationsView } from "@/components/views/EscalationsView";
import { FeatureView } from "@/components/views/FeatureView";
import { RunsView } from "@/components/views/RunsView";
import { RunView } from "@/components/views/RunView";
import { TaskView } from "@/components/views/TaskView";
import { UsageView } from "@/components/views/UsageView";
import { EmptyState } from "@/components/ui";
import { Link } from "./Link";
import { EngineProvider } from "./EngineProvider";

function Views({ serverPath }: { serverPath: string }) {
  const route = useRoute(serverPath);
  const p = (name: string) => route.params.get(name);
  const main = useRef(route.view);
  useEffect(() => {
    // Move focus to the page on a view change, so keyboard and screen-reader users land on it.
    if (main.current !== route.view) document.getElementById("main")?.focus();
    main.current = route.view;
  }, [route.view]);
  let view;
  switch (route.view) {
    case "runs":
      view = <RunsView />;
      break;
    case "run":
      view = (
        <RunView
          run={p("run")}
          zoom={(p("zoom") === "tasks" ? "tasks" : "phases") satisfies RunZoom}
          node={p("node")}
        />
      );
      break;
    case "task":
      view = <TaskView run={p("run")} task={p("task")} node={p("node")} />;
      break;
    case "feature":
      view = <FeatureView run={p("run")} feature={p("feature")} />;
      break;
    case "escalations":
      view = <EscalationsView run={p("run")} />;
      break;
    case "usage":
      view = <UsageView />;
      break;
    case "artifact":
      view = <ArtifactView run={p("run")} path={p("path")} />;
      break;
    case "design":
      view = <DesignReviewView run={p("run")} params={route.params} />;
      break;
    case "not_found":
      view = (
        <EmptyState
          title="No such page"
          action={
            <Link className="text-sm text-accent-fg underline" href="/">
              Go to runs
            </Link>
          }
        />
      );
      break;
  }
  return <AppShell route={route}>{view}</AppShell>;
}

/**
 * Flow Studio (spec §17): the read-only dashboard. Every exported page renders this app; the
 * view comes from the address (AD-20), so navigation never reloads the page.
 */
export function FlowStudio({
  serverPath,
  fetchImpl,
}: {
  serverPath: string;
  fetchImpl?: typeof fetch;
}) {
  return (
    <ThemeProvider>
      <EngineProvider {...(fetchImpl === undefined ? {} : { fetchImpl })}>
        <Views serverPath={serverPath} />
      </EngineProvider>
    </ThemeProvider>
  );
}
