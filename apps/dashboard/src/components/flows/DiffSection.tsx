"use client";

import { describeError } from "@/lib/api/errors";
import { runTopic } from "@/lib/api/topics";
import { useResource } from "@/lib/useResource";
import { Section } from "./DrawerParts";
import { REDACT } from "@/lib/redact";

/** The task's latest verified diff (§17 drill-down), shown as text (never rendered as HTML). */
export function DiffSection({ run, task }: { run: string; task: string }) {
  const diff = useResource(`diff:${run}:${task}`, (c, s) => c.taskDiff(run, task, s), [
    runTopic(run, `task:${task}`),
  ]);
  return (
    <Section title="Diff">
      {diff.error === null ? null : (
        <p className="text-xs text-danger">{describeError(diff.error)}</p>
      )}
      {diff.data === undefined ? (
        diff.error === null ? (
          <p className="text-xs text-muted-fg">Loading…</p>
        ) : null
      ) : (
        <>
          <ul className="space-y-1 text-xs" {...REDACT}>
            {diff.data.files.map((f) => (
              <li key={f.path} className="flex justify-between gap-2 font-mono">
                <span className="truncate">
                  {f.status === "renamed" && f.old_path !== undefined ? `${f.old_path} → ` : ""}
                  {f.path}
                </span>
                <span className="shrink-0 tabular">
                  <span className="text-ok">+{f.additions}</span>{" "}
                  <span className="text-danger">−{f.deletions}</span>
                </span>
              </li>
            ))}
          </ul>
          <details className="text-xs">
            <summary className="text-muted-fg hover:text-fg">
              Patch{diff.data.truncated ? " (cut short)" : ""}
            </summary>
            <pre
              className="mt-1 max-h-80 overflow-auto rounded-xl bg-surface-2 p-3 font-mono text-[11px] whitespace-pre"
              {...REDACT}
            >
              {diff.data.patch}
            </pre>
          </details>
        </>
      )}
    </Section>
  );
}
