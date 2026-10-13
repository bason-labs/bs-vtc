/**
 * Storage driver on `node:sqlite` (Node >= 22.13), used in development and tests (AD-2).
 * The compiled binary uses a `bun:sqlite` driver with the same contract.
 * This is the only file allowed to import `node:sqlite` (dependency-cruiser AD2 rule).
 */
import { DatabaseSync } from "node:sqlite";
import type { PreparedStatement, SqlValue, Storage, StorageFactory } from "@vtc/shared";

export const openNodeSqlite: StorageFactory = ({ path, readonly = false }) => {
  const db = new DatabaseSync(path, { readOnly: readonly });
  if (!readonly) db.exec("PRAGMA foreign_keys = ON;");
  let inTransaction = false;

  const storage: Storage = {
    driver: "node:sqlite",
    path,
    exec(sql) {
      db.exec(sql);
    },
    prepare(sql): PreparedStatement {
      const statement = db.prepare(sql);
      return {
        run: (...params: SqlValue[]) => {
          const result = statement.run(...params);
          return { changes: Number(result.changes), lastInsertRowid: result.lastInsertRowid };
        },
        get: (...params: SqlValue[]) => statement.get(...params),
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
