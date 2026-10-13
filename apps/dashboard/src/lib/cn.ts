import { twMerge } from "tailwind-merge";

/**
 * Joins class names, skipping falsy values, and resolves Tailwind conflicts so the last one wins
 * (copied from bs-job-agents).
 */
export function cn(...parts: (string | false | null | undefined)[]): string {
  return twMerge(parts.filter(Boolean).join(" "));
}
