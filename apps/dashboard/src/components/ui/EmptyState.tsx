import { Inbox } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Copied from bs-job-agents components/ui/EmptyState. */
export function EmptyState({ title, description, icon, action, className }: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-3 rounded-3xl border border-dashed border-border bg-surface/40 px-6 py-10 text-center",
        className,
      )}
    >
      <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-accent-fg [&_svg]:size-6">
        {icon ?? <Inbox aria-hidden />}
      </div>
      <div className="space-y-1">
        <p className="font-display text-base font-semibold">{title}</p>
        {description === undefined ? null : (
          <p className="mx-auto max-w-md text-sm text-muted-fg">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}
