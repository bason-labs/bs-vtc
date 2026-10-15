import type { RoleRunNote } from "@/lib/role-run-notes";
import { REDACT } from "@/lib/redact";

/**
 * A role run's cost (an unpriced model shows as unknown, with what it counts toward the budget;
 * H-12) and the model fallback of its dispatch (D-cx). Nothing when neither is known.
 */
export function RoleRunNoteLines({ note }: { note: RoleRunNote | null | undefined }) {
  if (note === null || note === undefined || (note.cost === null && note.fallback === null))
    return null;
  return (
    <>
      {note.cost === null ? null : (
        <p className="text-xs tabular" data-testid="run-cost">
          {note.cost}
        </p>
      )}
      {note.fallback === null ? null : (
        <p className="text-xs text-warn-fg" data-testid="run-fallback">
          {note.fallback}
          {note.fallbackDetail === null ? null : (
            <span className="text-muted-fg" {...REDACT}>
              {" "}
              ({note.fallbackDetail})
            </span>
          )}
        </p>
      )}
    </>
  );
}
