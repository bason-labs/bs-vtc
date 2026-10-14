import { AlertTriangle, Cpu } from "lucide-react";
import { cn } from "@/lib/cn";
import type { VisualToolchainModel } from "@/lib/visual";

/**
 * What a visual step's outcome means (AD-24): why it was skipped, as a visible note (no browser,
 * or Linux `ptrace_scope` 0, D-bj), what its status means for the run, and whose Playwright ran
 * it (a pass on the project's own is not a Level-3 pass, spine §5 readings 124, 136).
 */
export function VisualNotes({
  reason,
  notes,
  toolchain,
  className,
}: {
  reason: string | null;
  notes: readonly string[];
  toolchain: VisualToolchainModel | null;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      {reason === null ? null : (
        <p
          role="note"
          aria-label="Why the visual step was skipped"
          className="flex gap-1.5 rounded-lg border border-warn/40 bg-warn/10 px-2 py-1.5 text-warn-fg"
        >
          <AlertTriangle aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          <span className="break-words">{reason}</span>
        </p>
      )}
      {notes.map((n) => (
        <p key={n} className="text-muted-fg">
          {n}
        </p>
      ))}
      {toolchain === null ? null : (
        <>
          <p className="inline-flex items-center gap-1 text-muted-fg">
            <Cpu aria-hidden className="size-3.5" />
            Toolchain: {toolchain.label}
          </p>
          {toolchain.note === null ? null : (
            <p
              role="note"
              aria-label="Toolchain"
              className="rounded-lg border border-warn/40 bg-warn/10 px-2 py-1.5 text-warn-fg"
            >
              {toolchain.note}
            </p>
          )}
        </>
      )}
    </div>
  );
}
