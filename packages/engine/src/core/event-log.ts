/**
 * The one append path of the event log (AD-7 rule 2). Only the holder of the engine lock
 * (AD-12) can append; every event's `data` passes the secret-redaction filter (`redactJson`,
 * AD-18) because the log is committed to git, is validated (`toEventLine`) and gets the next
 * per-run `seq`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVENT_SCHEMA_VERSION,
  EventSchema,
  eventLogPath,
  parseEventLog,
  redactJson,
  toEventLine,
  type VtcEvent,
  type VtcEventInput,
} from "@vtc/shared";
import { appendRepoFile, assertNoSymlinks } from "../git/index.js";
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
  /**
   * Known secret values to redact besides the built-in token formats (e.g. the repo's `.env`
   * values via `dotenvValues`). Read on every append, so new values apply at once.
   */
  readonly secrets?: () => readonly string[];
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
  const rel = eventLogPath(run);
  const path = join(repoRoot, rel);
  const now = options.now ?? (() => new Date());
  const secrets = options.secrets ?? (() => []);
  assertNoSymlinks(repoRoot, rel);
  const parsed = existsSync(path)
    ? parseEventLog(readFileSync(path, "utf8"))
    : { events: [], invalidLines: [], truncatedTail: false };
  if (parsed.truncatedTail) appendRepoFile(repoRoot, rel, "\n");
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
        ...(draft.data === undefined ? {} : { data: redactJson(draft.data, secrets()) }),
        v: EVENT_SCHEMA_VERSION,
        seq: next,
        run,
        ts: draft.ts ?? now().toISOString(),
      });
      appendRepoFile(repoRoot, rel, toEventLine(event));
      next += 1;
      return event;
    },
  };
};
