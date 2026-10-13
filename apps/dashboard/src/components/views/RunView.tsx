"use client";

import { useCallback } from "react";
import { runTopic } from "@/lib/api/topics";
import { cn } from "@/lib/cn";
import { hrefs, navigate, type RunZoom } from "@/lib/router";
import { useResource } from "@/lib/useResource";
import { Link } from "@/components/app/Link";
import { FlowCanvas } from "@/components/flows/FlowCanvas";
import { NodeList } from "@/components/flows/NodeList";
import { RunNodeDrawer } from "@/components/flows/RunNodeDrawer";
import { RunNotices } from "@/components/notices/RunNotices";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

const ZOOMS: readonly { zoom: RunZoom; label: string }[] = [
  { zoom: "phases", label: "Project phases" },
  { zoom: "tasks", label: "Task DAG" },
];

/** Zoom levels 1 and 2 (§17): the run's phases, and its task DAG. */
export function RunView({
  run,
  zoom,
  node,
}: {
  run: string | null;
  zoom: RunZoom;
  node: string | null;
}) {
  const key = run ?? "";
  const scope = zoom === "tasks" ? "task_dag" : "project";
  const graph = useResource(
    run === null ? null : `graph:${key}:${scope}`,
    (c, s) => c.graph(key, scope, undefined, s),
    run === null ? [] : [runTopic(key, "graph")],
  );
  const tasks = useResource(
    run === null || zoom !== "tasks" ? null : `tasks:${key}`,
    (c, s) => c.tasks(key, s),
    run === null ? [] : [runTopic(key, "tasks")],
  );
  const select = useCallback(
    (id: string) => {
      navigate(hrefs.run(key, zoom, id));
    },
    [key, zoom],
  );
  const close = useCallback(() => {
    navigate(hrefs.run(key, zoom));
  }, [key, zoom]);
  if (run === null) return <MissingParam what="run" />;
  const selected = graph.data?.nodes.find((n) => n.id === node) ?? null;
  const task =
    selected?.task === undefined
      ? null
      : (tasks.data?.tasks.find((t) => t.id === selected.task) ?? null);
  return (
    <>
      <Breadcrumbs items={[{ label: "Runs", href: hrefs.runs() }, { label: run }]} />
      <PageHeader title={`Run ${run}`}>
        <nav
          aria-label="Zoom level"
          className="flex gap-1 rounded-2xl border border-border bg-surface/70 p-1"
        >
          {ZOOMS.map((z) => (
            <Link
              key={z.zoom}
              href={hrefs.run(run, z.zoom)}
              aria-current={z.zoom === zoom ? "page" : undefined}
              className={cn(
                "rounded-xl px-3 py-1.5 text-sm transition",
                z.zoom === zoom ? "bg-brand text-white" : "text-muted-fg hover:text-fg",
              )}
            >
              {z.label}
            </Link>
          ))}
        </nav>
      </PageHeader>
      <RunNotices run={run} />
      <Loaded resource={graph} skeleton="h-[56vh]">
        {(g) => (
          <div className="space-y-4">
            <FlowCanvas
              graph={g}
              selected={node}
              onSelect={select}
              label={zoom === "tasks" ? `Task DAG of ${run}` : `Phases of ${run}`}
            />
            <NodeList graph={g} selected={node} onSelect={select} />
          </div>
        )}
      </Loaded>
      <RunNodeDrawer run={run} node={selected} task={task} onClose={close} />
    </>
  );
}
