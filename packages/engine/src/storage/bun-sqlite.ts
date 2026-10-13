/// <reference path="./bun-sqlite-module.d.ts" />
/**
 * Storage driver on `bun:sqlite`, used by the single-file binary (AD-2). Same contract as the
 * node:sqlite driver; `get()` returns `undefined` for "no row" (Bun returns `null`).
 * This is the only file allowed to import `bun:*` (dependency-cruiser AD2 rule). It is loaded
 * lazily and never evaluated under Node; its contract tests run in the Bun binary job.
 */
import { Database } from "bun:sqlite";
import type { PreparedStatement, SqlValue, Storage, StorageFactory } from "@vtc/shared";

export const openBunSqlite: StorageFactory = ({ path, readonly = false }) => {
  const db = new Database(path, readonly ? { readonly: true } : { create: true, readwrite: true });
  if (!readonly) db.exec("PRAGMA foreign_keys = ON;");
  let inTransaction = false;

  const storage: Storage = {
    driver: "bun:sqlite",
    path,
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql): PreparedStatement {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => {
          const result = statement.run(...params);
          return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
        },
        get: (...params: SqlValue[]) => statement.get(...params) ?? undefined,
        all: (...params: SqlValue[]) => statement.all(...params),
      };
    },
    transaction<T>(fn: () => T): T {
      if (inTransaction) throw new Error("storage transactions are not re-entrant");
      inTransaction = true;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        if (result instanceof Promise) {
          throw new TypeError(
            "storage transactions are synchronous; do not pass an async function",
          );
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      db.close();
    },
  };
  return storage;
};
