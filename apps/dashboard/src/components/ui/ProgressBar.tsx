import { cn } from "@/lib/cn";

export interface ProgressBarProps {
  /** 0..100, or `null` for unknown (an empty, hatched bar; never shown as 0%). */
  value: number | null;
  tone?: "brand" | "warn" | "danger";
  label: string;
  className?: string;
}

/** Copied from bs-job-agents components/ui/ProgressBar, plus an unknown state (§6.9). */
export function ProgressBar({ value, tone = "brand", label, className }: ProgressBarProps) {
  if (value === null) {
    return (
      <div
        role="img"
        aria-label={`${label}: unknown`}
        className={cn(
          "h-2 w-full rounded-full border border-dashed border-border bg-[repeating-linear-gradient(45deg,var(--surface-2)_0_4px,var(--surface-3)_4px_8px)]",
          className,
        )}
      />
    );
  }
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      className={cn("h-2 w-full overflow-hidden rounded-full bg-surface-3", className)}
    >
      <div
        className={cn(
          "h-full rounded-full transition-[width]",
          tone === "brand" ? "bg-gradient-brand" : tone === "warn" ? "bg-warn" : "bg-danger",
        )}
        style={{ width: `${String(pct)}%` }}
      />
    </div>
  );
}
