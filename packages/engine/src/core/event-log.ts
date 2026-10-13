/**
 * The one append path of the event log (AD-7 rule 2). Only the holder of the engine lock
 * (AD-12) can append; every event is validated (`toEventLine`) and gets the next per-run `seq`.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  EVENT_SCHEMA_VERSION,
  EventSchema,
  eventLogPath,
  parseEventLog,
  toEventLine,
  type VtcEvent,
  type VtcEventInput,
} from "@vtc/shared";
import { EngineLockedError, type EngineLock } from "./lock.js";

/** An event before the writer stamps `v`, `seq`, `run` and (by default) `ts`. */
export type EventDraft = Omit<VtcEventInput, "v" | "seq" | "run" | "ts"> & { readonly ts?: string };

export interface EventLogWriter {
  readonly run: string;
  /** Absolute path of the log. */
  readonly path: string;
  /** What `parseEventLog` reported when the log was opened (an incident when not clean). */
  readonly recovered: { readonly invalidLines: readonly number[]; readonly truncatedTail: boolean };
  /** The `seq` the next append will get. */
  nextSeq(): number;
  append(draft: EventDraft): VtcEvent;
}

export interface OpenEventLogOptions {
  readonly now?: () => Date;
}

/**
 * Opens a run's log for appending. Existing valid events set the next `seq`; a torn final line
 * (a crash mid-write) is left in place and fenced off with a newline, so replay reports it as
 * one invalid line and new events start clean.
 */
export const openEventLog = (
  repoRoot: string,
  run: string,
  lock: EngineLock,
  options: OpenEventLogOptions = {},
): EventLogWriter => {
  if (!lock.isHeld()) throw new EngineLockedError(lock.path, null);
  const path = join(repoRoot, eventLogPath(run));
  const now = options.now ?? (() => new Date());
  mkdirSync(dirname(path), { recursive: true });
  const parsed = existsSync(path)
    ? parseEventLog(readFileSync(path, "utf8"))
    : { events: [], invalidLines: [], truncatedTail: false };
  if (parsed.truncatedTail) appendFileSync(path, "\n");
  let next = parsed.events.reduce((max, event) => Math.max(max, event.seq), 0) + 1;
  return {
    run,
    path,
    recovered: { invalidLines: parsed.invalidLines, truncatedTail: parsed.truncatedTail },
    nextSeq: () => next,
    append: (draft) => {
      if (!lock.isHeld()) throw new EngineLockedError(lock.path, null);
      const event = EventSchema.parse({
        ...draft,
        v: EVENT_SCHEMA_VERSION,
        seq: next,
        run,
        ts: draft.ts ?? now().toISOString(),
      });
      appendFileSync(path, toEventLine(event));
      next += 1;
      return event;
    },
  };
};
