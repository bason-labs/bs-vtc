"use client";

import * as RadixDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { useReturnFocus } from "./focus";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Small caps line above the title (e.g. "Role · spec_verifier"). */
  eyebrow?: ReactNode;
  children: ReactNode;
  "data-testid"?: string;
}

/**
 * Side panel from the right (copied from bs-job-agents components/ui/Drawer): full width on a
 * phone, 440 px from `sm`. Modal: dim backdrop, Esc / ✕ / backdrop click close it, focus stays
 * inside and returns to the opener.
 */
export function Drawer({
  open,
  onOpenChange,
  title,
  eyebrow,
  children,
  "data-testid": testId,
}: DrawerProps) {
  const focus = useReturnFocus();
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <RadixDialog.Content
          data-testid={testId}
          {...focus}
          aria-describedby={undefined}
          className={cn(
            "fixed inset-y-0 right-0 z-50 flex w-full flex-col overflow-hidden border-l border-border bg-surface shadow-2xl outline-none sm:w-[440px]",
          )}
        >
          <div className="flex items-start justify-between gap-3 border-b border-border/60 p-4 sm:p-5">
            <div className="min-w-0">
              {eyebrow === undefined ? null : (
                <p className="text-[11px] tracking-wider text-muted-fg uppercase">{eyebrow}</p>
              )}
              <RadixDialog.Title className="font-display text-lg font-semibold break-words">
                {title}
              </RadixDialog.Title>
            </div>
            <RadixDialog.Close
              aria-label="Close"
              title="Close (Esc)"
              className="-mt-1 -mr-1 grid size-9 shrink-0 place-items-center rounded-xl text-muted-fg hover:bg-surface-2 hover:text-fg"
            >
              <X aria-hidden className="size-4" />
            </RadixDialog.Close>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:p-5">{children}</div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
