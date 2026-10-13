"use client";

import { useId } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedOption<T extends string | number> {
  readonly value: T;
  readonly label: string;
}

/**
 * A row of native radio buttons styled as a segmented control: arrow keys move between options,
 * and each option is labelled for screen readers.
 */
export function Segmented<T extends string | number>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="min-w-0">
      <legend className="mb-1 text-[11px] font-medium text-muted-fg">{legend}</legend>
      <div className="flex flex-wrap gap-1">
        {options.map((o) => (
          <label key={String(o.value)} className="relative">
            <input
              type="radio"
              name={name}
              value={String(o.value)}
              checked={o.value === value}
              onChange={() => {
                onChange(o.value);
              }}
              className="peer sr-only"
            />
            <span
              className={cn(
                "inline-flex h-8 cursor-pointer items-center rounded-xl border px-3 text-xs transition",
                "peer-focus-visible:shadow-[var(--ring-focus)]",
                o.value === value
                  ? "border-brand bg-brand text-white"
                  : "border-border text-muted-fg hover:bg-surface-2 hover:text-fg",
              )}
            >
              {o.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
