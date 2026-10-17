import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface IconButtonProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "aria-label"
> {
  /** Required: icon-only buttons need an accessible name. */
  label: string;
  icon: ReactNode;
  size?: "sm" | "md";
}

/** Copied from bs-job-agents components/ui/IconButton. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, size = "md", className, type = "button", title, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={title ?? label}
      className={cn(
        "inline-grid shrink-0 place-items-center rounded-xl text-muted-fg transition hover:bg-surface-2 hover:text-fg disabled:opacity-50",
        size === "sm" ? "size-8 [&_svg]:size-3.5" : "size-9 [&_svg]:size-4",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});
