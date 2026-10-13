/**
 * The unfinished runs of a repo, read straight from the committed event logs
 * (`.vtc/runs/<run>/events.jsonl`, `eventLogPath`) for `vtc hook session-start` (hook rule 3; D-af,
 * spine §5 reading 52). After a reboot the bridge starts the daemon at the same moment the Lead
 * session starts, so the resume hint cannot wait for it.
 *
 * Read only and tolerant: files are opened read-only and never written; a line that is not JSON,
 * a torn last line or an unknown event is skipped; a log that is not a regular file (a directory,
 * a symlink) is skipped and never followed. Only the run lifecycle events matter (`run.started`,
 * `run.phase_changed`, `run.paused` / `run.resumed`, `run.finished`).
 *
 * The logs are git-tracked, so a cloned repo controls them, and what this returns goes into the
 * Lead's context. So nothing unvalidated gets through: a run directory counts only when its name
 * is a `RunIdSchema` id, and a lifecycle line only when it is a valid `EventSchema` event (typed
 * payload included, so `track` is a `TrackSchema` value and `phase` a `PhaseSchema` one) of that
 * same run. Anything else is skipped like a torn line. The reader works in chunks
 * and gives up with {@link RunLogDeadlineError} once `deadline` passes, so the hook stays within
 * `VTC_HOOK.timeoutMs` and fails open.
 */
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
  EventSchema,
  RunIdSchema,
  isEventOfType,
  parsePersisted,
  readEventData,
  type Phase,
  type Track,
  type VtcEvent,
} from "@vtc/shared";

/** Where the engine keeps one directory per run (`eventLogPath`). */
export const RUNS_DIR = ".vtc/runs";
const EVENTS_FILE = "events.jsonl";

const CHUNK_BYTES = 64 * 1024;
/** Longer lines are not lifecycle events (theirs are small); they are skipped unread. */
const MAX_LINE_BYTES = 1024 * 1024;
/** A quick filter before JSON.parse: only `run.*` events can matter. */
const RUN_EVENT = /"type"\s*:\s*"run\./;

export interface UnfinishedRun {
  /** A `RunIdSchema` id (the run directory's name). */
  readonly id: string;
  /** From `run.started`. */
  readonly track: Track | null;
  /** The latest `run.phase_changed` target, or `null`. */
  readonly phase: Phase | null;
  readonly paused: boolean;
}

export class RunLogDeadlineError extends Error {
  constructor() {
    super("the event logs were not read before the deadline");
    this.name = "RunLogDeadlineError";
  }
}

interface Lifecycle {
  started: boolean;
  finished: boolean;
  track: Track | null;
  phase: Phase | null;
  paused: boolean;
}

/** The line as a valid event of `run`, or `null` (not JSON, invalid, another run's). */
const eventOf = (run: string, line: string): VtcEvent | null => {
  if (!RUN_EVENT.test(line)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  // a reader of persisted data: a key a newer MINOR vtc added is dropped, not an error (AD-3)
  const parsed = parsePersisted(EventSchema, raw);
  return parsed.success && parsed.data.run === run ? parsed.data : null;
};

const apply = (state: Lifecycle, run: string, line: string): void => {
  const event = eventOf(run, line);
  if (event === null) return;
  // EventSchema has already validated each core payload, so readEventData does not throw
  if (isEventOfType(event, "run.started")) {
    state.started = true;
    state.track = readEventData(event).track;
    return;
  }
  if (isEventOfType(event, "run.phase_changed")) {
    state.phase = readEventData(event).to;
    return;
  }
  switch (event.type) {
    case "run.paused":
      state.paused = true;
      break;
    case "run.resumed":
      state.paused = false;
      break;
    case "run.finished":
      state.finished = true;
      break;
  }
};

/** Replays one log's lifecycle events, chunk by chunk, checking the deadline between chunks. */
const readLifecycle = async (run: string, path: string, deadline: number): Promise<Lifecycle> => {
  const state: Lifecycle = {
    started: false,
    finished: false,
    track: null,
    phase: null,
    paused: false,
  };
  // read only, and never through a symlink swapped in after the lstat
  const file = await open(
    path,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.alloc(CHUNK_BYTES);
    let pending = "";
    let skipping = false;
    for (;;) {
      if (Date.now() > deadline) throw new RunLogDeadlineError();
      const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null);
      if (bytesRead === 0) break;
      const lines = (pending + decoder.write(buffer.subarray(0, bytesRead))).split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (!skipping) apply(state, run, line);
        skipping = false;
      }
      if (pending.length > MAX_LINE_BYTES) {
        pending = "";
        skipping = true; // the rest of this over-long line is skipped too
      }
    }
    if (!skipping) apply(state, run, pending);
  } finally {
    await file.close();
  }
  return state;
};

/** Run-id order, numbers by value (`R-2026-10-14-9` before `R-2026-10-14-10`). */
const byRunId = new Intl.Collator("en", { numeric: true }).compare;

/**
 * Every run in `repoRoot` whose log has a valid `run.started` and no `run.finished`, oldest first
 * in run-id order. Rejects with {@link RunLogDeadlineError} once `deadline` (epoch ms) passes.
 */
export const unfinishedRuns = async (
  repoRoot: string,
  deadline: number,
): Promise<UnfinishedRun[]> => {
  if (Date.now() > deadline) throw new RunLogDeadlineError();
  let entries;
  try {
    entries = await readdir(join(repoRoot, RUNS_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: UnfinishedRun[] = [];
  const ids = entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => RunIdSchema.safeParse(name).success)
    .sort(byRunId);
  for (const id of ids) {
    const path = join(repoRoot, RUNS_DIR, id, EVENTS_FILE);
    try {
      if (!(await lstat(path)).isFile()) continue;
    } catch {
      continue;
    }
    let state: Lifecycle;
    try {
      state = await readLifecycle(id, path, deadline);
    } catch (error) {
      if (error instanceof RunLogDeadlineError) throw error;
      continue;
    }
    if (state.started && !state.finished)
      runs.push({ id, track: state.track, phase: state.phase, paused: state.paused });
  }
  return runs;
};
