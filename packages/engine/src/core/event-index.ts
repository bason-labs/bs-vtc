/**
 * The SQLite index of the event logs (AD-2 rule 4, AD-7 rule 5): a cache the engine rebuilds from
 * `events.jsonl` on start and appends to as events happen. Losing it loses nothing.
 */
import type { Storage, VtcEvent } from "@vtc/shared";
import type { RunState } from "./state.js";

export const INDEX_PATH = ".vtc/state/index.sqlite";

export interface EventIndex {
  append(event: VtcEvent): void;
  /** Number of indexed events of a run. */
  count(run: string): number;
  close(): void;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  run TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  task TEXT,
  feature TEXT,
  json TEXT NOT NULL,
  PRIMARY KEY (run, seq)
);
CREATE INDEX IF NOT EXISTS events_by_task ON events (run, task);
CREATE INDEX IF NOT EXISTS events_by_type ON events (run, type);
`;

/** Opens the index and rebuilds it from the replayed runs. */
export const openEventIndex = (storage: Storage, runs: Iterable<RunState>): EventIndex => {
  storage.exec(SCHEMA);
  const insert = storage.prepare(
    "INSERT OR REPLACE INTO events (run, seq, ts, type, task, feature, json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const row = (event: VtcEvent): void => {
    insert.run(
      event.run,
      event.seq,
      event.ts,
      event.type,
      event.task ?? null,
      event.feature ?? null,
      JSON.stringify(event),
    );
  };
  storage.transaction(() => {
    storage.exec("DELETE FROM events");
    for (const state of runs) for (const event of state.events) row(event);
  });
  const counter = storage.prepare("SELECT COUNT(*) AS n FROM events WHERE run = ?");
  return {
    append: row,
    count: (run) => Number(counter.get(run)?.n ?? 0),
    close: () => {
      storage.close();
    },
  };
};
