"use client";

import { useEffect, useState } from "react";
import { useEvidenceMode } from "./useEvidenceMode";

/**
 * The current time, re-read every `intervalMs` (ages and countdowns tick without new data). In
 * evidence mode the clock stands still, so a recording does not change with the wall clock.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  const frozen = useEvidenceMode() !== "off";
  useEffect(() => {
    if (frozen) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, intervalMs);
    return () => {
      clearInterval(timer);
    };
  }, [intervalMs, frozen]);
  return now;
}
