/**
 * Minimal ambient types for `bun:sqlite` (AD-2 rule 3): only the members the Bun driver uses,
 * so Node-only typecheck, lint and build never need Bun. The Bun binary job runs the storage
 * contract suite against the real module, which catches any drift (sub-project 0/1).
 */
declare module "bun:sqlite" {
  type BunSqlValue = null | number | bigint | string | Uint8Array;

  export interface Statement {
    run(...params: BunSqlValue[]): { changes: number; lastInsertRowid: number | bigint };
    /** Returns `null` (not `undefined`) when there is no row. */
    get(...params: BunSqlValue[]): Record<string, BunSqlValue> | null;
    all(...params: BunSqlValue[]): Record<string, BunSqlValue>[];
  }

  export class Database {
    constructor(
      filename: string,
      options?: { readonly?: boolean; create?: boolean; readwrite?: boolean },
    );
    exec(sql: string): void;
    prepare(sql: string): Statement;
    close(): void;
  }
}
