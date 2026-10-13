import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";
import type { StatusMeta, Tone } from "@/lib/states";

const TONES: Record<Tone, string> = {
  neutral: "border-border text-muted-fg",
  brand: "border-brand/40 text-brand bg-brand/5 dark:text-accent-fg",
  accent: "border-accent/40 text-accent-fg bg-accent/5",
  ok: "border-ok/40 text-ok bg-ok/5",
  warn: "border-warn/40 text-warn-fg bg-warn/10",
  danger: "border-danger/40 text-danger bg-danger/5",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

/** Small rounded label (copied from bs-job-agents components/ui/Badge). */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-none font-medium whitespace-nowrap",
        TONES[tone],
        className,
      )}
      {...rest}
    />
  );
}

/** A status with a consistent label, tone and live dot. */
export function StatusPill({ meta, className }: { meta: StatusMeta; className?: string }) {
  return (
    <Badge tone={meta.tone} className={className}>
      <span
        aria-hidden
        className={cn("size-1.5 rounded-full bg-current", meta.live === true && "animate-pulse")}
      />
      {meta.label}
    </Badge>
  );
}
