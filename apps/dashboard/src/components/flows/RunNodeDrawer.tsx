"use client";

import type { Task, WorkflowNode } from "@vtc/shared";
import { ArrowRight } from "lucide-react";
import { hrefs } from "@/lib/router";
import { nodeStateMeta, taskStatusMeta } from "@/lib/states";
import { Link } from "@/components/app/Link";
import { buttonClass, Drawer, StatusPill } from "@/components/ui";
import { Section, Stat } from "./DrawerParts";
import { nodeEyebrow } from "./StepNode";

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** Drawer for a project-phase or task-DAG node: state, why it is there and, for a task, its plan. */
export function RunNodeDrawer({
  run,
  node,
  task,
  onClose,
}: {
  run: string;
  node: WorkflowNode | null;
  task: Task | null;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={node !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={node?.label ?? ""}
      eyebrow={node === null ? undefined : nodeEyebrow({ node, meta: nodeStateMeta(node) })}
      data-testid="run-node-drawer"
    >
      {node === null ? null : (
        <>
          <dl className="grid grid-cols-2 gap-2">
            <Stat label="State">
              <StatusPill meta={nodeStateMeta(node)} />
            </Stat>
            <Stat label="Round">
              {node.round === undefined || node.cap === undefined
                ? "—"
                : `${String(node.round)}/${String(node.cap)}`}
            </Stat>
          </dl>
          <Section title="Why this node">
            <p className="text-sm">{node.reason_added}</p>
          </Section>
          {task === null ? null : (
            <Section title={`Task ${task.id}`}>
              <dl className="grid grid-cols-2 gap-2">
                <Stat label="Status">
                  <StatusPill meta={taskStatusMeta(task)} />
                </Stat>
                <Stat label="Discipline">{task.discipline}</Stat>
                <Stat label="Risk">{task.risk}</Stat>
                <Stat label="Budget">
                  {usd(task.spent_usd)} / {usd(task.budget_usd)}
                </Stat>
                <Stat label="Covers">{task.covers.join(", ") || "—"}</Stat>
                <Stat label="After">{task.after.join(", ") || "—"}</Stat>
              </dl>
              <p className="text-xs text-muted-fg">
                Scope <code className="font-mono">{task.files_scope.join(", ")}</code>
              </p>
            </Section>
          )}
          {node.task === undefined ? null : (
            <Link
              href={hrefs.task(run, node.task)}
              className={buttonClass({ variant: "primary", size: "sm" })}
            >
              Open pipeline <ArrowRight aria-hidden className="size-3.5" />
            </Link>
          )}
        </>
      )}
    </Drawer>
  );
}
