import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

/** Glass card (copied from bs-job-agents components/ui/Card). */
export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>) {
  return (
    <section
      className={cn(
        "rounded-3xl border border-border bg-surface/70 p-4 backdrop-blur-md sm:p-5",
        className,
      )}
      {...rest}
    />
  );
}

export function CardHeader({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("mb-3 flex flex-wrap items-start justify-between gap-2", className)}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: HTMLAttributes<HTMLHeadingElement>) {
  return <h2 className={cn("font-display text-base font-semibold", className)} {...rest} />;
}

export function CardDescription({ className, ...rest }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-muted-fg", className)} {...rest} />;
}
