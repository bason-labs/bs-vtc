/**
 * Storage interface (AD-2). The SQLite index in `.vtc/state/` is a rebuildable cache of the
 * event log; the engine talks to it only through this interface so the same code runs on
 * `node:sqlite` (dev, tests) and `bun:sqlite` (the compiled binary).
 *
 * Deliberately the common subset of both drivers: positional `?` parameters only, synchronous
 * calls, rows as plain objects.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;
export type SqlRow = Readonly<Record<string, SqlValue>>;

export interface SqlRunResult {
  readonly changes: number;
  readonly lastInsertRowid: number | bigint;
}

export interface PreparedStatement {
  run(...params: SqlValue[]): SqlRunResult;
  get(...params: SqlValue[]): SqlRow | undefined;
  all(...params: SqlValue[]): SqlRow[];
}

export type StorageDriverName = "node:sqlite" | "bun:sqlite";

export interface Storage {
  readonly driver: StorageDriverName;
  /** File path, or `:memory:`. */
  readonly path: string;
  /** Execute one or more statements without parameters (DDL, pragmas). */
  exec(sql: string): void;
  prepare(sql: string): PreparedStatement;
  /** Run `fn` in a transaction; commit on return, roll back on throw. Not re-entrant. */
  transaction<T>(fn: () => T): T;
  close(): void;
}

export interface StorageOptions {
  /** File path, or `:memory:`. */
  readonly path: string;
  readonly readonly?: boolean;
}

export type StorageFactory = (options: StorageOptions) => Storage;
