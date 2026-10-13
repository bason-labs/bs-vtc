"use client";

import { useRef, type RefObject } from "react";

/**
 * Focus return for layers opened from code (copied from bs-job-agents): Radix only refocuses a
 * Dialog.Trigger, so a drawer opened by state would leave focus on <body> when it closes. Spread
 * the handlers on the Radix Content: the element focused when the layer opened gets focus back.
 */
export function useReturnFocus(returnFocus?: RefObject<HTMLElement | null>) {
  const opener = useRef<HTMLElement | null>(null);
  return {
    onOpenAutoFocus: () => {
      const active = typeof document === "undefined" ? null : document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
    },
    onCloseAutoFocus: (event: Event) => {
      const target = returnFocus?.current ?? opener.current;
      opener.current = null;
      if (target?.isConnected === true) {
        event.preventDefault();
        target.focus();
      }
    },
  };
}
