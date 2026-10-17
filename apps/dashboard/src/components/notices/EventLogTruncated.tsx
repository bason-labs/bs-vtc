import { EVENT_PAGE_LIMIT } from "@vtc/shared";
import { cn } from "@/lib/cn";
import { MAX_EVENT_PAGES } from "@/lib/notices";

const LIMIT = (MAX_EVENT_PAGES * EVENT_PAGE_LIMIT.max).toLocaleString("en-US");

/**
 * Said wherever a view is built from a run's event log that is longer than the dashboard reads
 * (`RunEventLog.truncated`): the oldest events were read, the newest were not.
 */
export function EventLogTruncated({ className }: { className?: string }) {
  return (
    <p
      role="note"
      className={cn("text-xs text-warn-fg", className)}
      data-testid="event-log-truncated"
    >
      This run&apos;s event log is longer than the {LIMIT} events the dashboard reads. The newest
      events are not shown, so a waiting gate, a running role or a recent outcome here may be out of
      date.
    </p>
  );
}
