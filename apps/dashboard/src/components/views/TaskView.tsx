"use client";

import { useCallback, useMemo } from "react";
import { runTopic } from "@/lib/api/topics";
import { hrefs, navigate } from "@/lib/router";
import { roleRunNotes } from "@/lib/role-run-notes";
import { taskStatusMeta } from "@/lib/states";
import { useResource } from "@/lib/useResource";
import { useRunEvents } from "@/lib/useRunEvents";
import { FlowCanvas } from "@/components/flows/FlowCanvas";
import { NodeDrawer } from "@/components/flows/NodeDrawer";
import { NodeList } from "@/components/flows/NodeList";
import { TaskRouting } from "@/components/routing/TaskRouting";
import { Badge, StatusPill } from "@/components/ui";
import { Breadcrumbs, Loaded, MissingParam, PageHeader } from "./common";

/** Zoom level 3 (§17): one task's pipeline with its fix loop, and the node drawer. */
export function TaskView({
  run,
  task,
  node,
}: {
  run: string | null;
  task: string | null;
  node: string | null;
}) {
  const r = run ?? "";
  const t = task ?? "";
  const ok = run !== null && task !== null;
  const topics = ok ? [runTopic(r, "graph"), runTopic(r, `task:${t}`)] : [];
  const graph = useResource(
    ok ? `graph:${r}:task:${t}` : null,
    (c, s) => c.graph(r, "task", t, s),
    topics,
  );
  const detail = useResource(
    ok ? `task:${r}:${t}` : null,
    (c, s) => c.task(r, t, s),
    ok ? [runTopic(r, `task:${t}`), runTopic(r, "tasks")] : [],
  );
  // Each role run's cost (H-12) and model fallback (D-cx) are in the event log only.
  const events = useRunEvents(ok ? r : null, [`task:${t}`]);
  const notes = useMemo(
    () => (events.data === undefined ? undefined : roleRunNotes(events.data.events)),
    [events.data],
  );
  const select = useCallback(
    (id: string) => {
      navigate(hrefs.task(r, t, id));
    },
    [r, t],
  );
  const close = useCallback(() => {
    navigate(hrefs.task(r, t));
  }, [r, t]);
  if (run === null || task === null) return <MissingParam what="task" />;
  const info = detail.data?.task;
  const selected = graph.data?.nodes.find((n) => n.id === node) ?? null;
  return (
    <>
      <Breadcrumbs
        items={[
          { label: "Runs", href: hrefs.runs() },
          { label: run, href: hrefs.run(run, "tasks") },
          { label: task },
        ]}
      />
      <PageHeader
        title={info === undefined ? task : `${task} ${info.title}`}
        eyebrow="Task pipeline"
      >
        {info === undefined ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusPill meta={taskStatusMeta(info)} />
            <Badge>
              round {info.round}/{info.cap}
            </Badge>
            <Badge>risk {info.risk}</Badge>
            <Badge>{info.discipline}</Badge>
            <Badge tone="brand">{info.covers.join(", ") || "no REQ"}</Badge>
          </div>
        )}
      </PageHeader>
      <Loaded resource={graph} skeleton="h-[56vh]">
        {(g) => (
          <div className="space-y-4">
            <FlowCanvas graph={g} selected={node} onSelect={select} label={`Pipeline of ${task}`} />
            <NodeList graph={g} selected={node} onSelect={select} />
          </div>
        )}
      </Loaded>
      {detail.data === undefined ? null : (
        <div className="mt-4">
          <TaskRouting detail={detail.data} />
        </div>
      )}
      <NodeDrawer
        run={run}
        node={selected}
        detail={detail.data ?? null}
        onClose={close}
        {...(notes === undefined ? {} : { notes })}
      />
    </>
  );
}
