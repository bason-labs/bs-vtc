/**
 * Reusable Storage contract suite (AD-2 Check). Every driver (node:sqlite now, bun:sqlite with
 * the binary build) must pass it unchanged.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Storage, StorageFactory } from "@vtc/shared";

export const runStorageContract = (name: string, open: StorageFactory): void => {
  describe(`Storage contract: ${name}`, () => {
    const opened: Storage[] = [];
    const dirs: string[] = [];
    const mem = (): Storage => {
      const s = open({ path: ":memory:" });
      opened.push(s);
      return s;
    };
    afterEach(() => {
      for (const s of opened.splice(0)) {
        try {
          s.close();
        } catch {
          // already closed by the test
        }
      }
      for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
    });

    it("reports its driver and path", () => {
      const s = mem();
      expect(["node:sqlite", "bun:sqlite"]).toContain(s.driver);
      expect(s.path).toBe(":memory:");
    });

    it("runs DDL and positional-parameter statements", () => {
      const s = mem();
      s.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT NOT NULL, n INTEGER, b BLOB)");
      const insert = s.prepare("INSERT INTO t (name, n, b) VALUES (?, ?, ?)");
      const r1 = insert.run("a", 1, null);
      const r2 = insert.run("b", 2, new Uint8Array([1, 2]));
      expect(r1.changes).toBe(1);
      expect(Number(r2.lastInsertRowid)).toBe(2);
      expect(s.prepare("SELECT name, n FROM t WHERE id = ?").get(2)).toEqual({ name: "b", n: 2 });
      expect(s.prepare("SELECT name FROM t ORDER BY id").all()).toEqual([
        { name: "a" },
        { name: "b" },
      ]);
      expect(s.prepare("SELECT name FROM t WHERE id = ?").get(99)).toBeUndefined();
      const blob = s.prepare("SELECT b FROM t WHERE id = 2").get()?.b;
      expect(blob).toBeInstanceOf(Uint8Array);
      expect(Array.from(blob as Uint8Array)).toEqual([1, 2]);
    });

    it("commits and rolls back transactions", () => {
      const s = mem();
      s.exec("CREATE TABLE t (v TEXT)");
      const insert = s.prepare("INSERT INTO t (v) VALUES (?)");
      expect(s.transaction(() => insert.run("kept").changes)).toBe(1);
      expect(() =>
        s.transaction(() => {
          insert.run("dropped");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(s.prepare("SELECT v FROM t").all()).toEqual([{ v: "kept" }]);
    });

    it("refuses nested and async transactions", () => {
      const s = mem();
      s.exec("CREATE TABLE t (v TEXT)");
      expect(() => s.transaction(() => s.transaction(() => 1))).toThrow(/re-entrant/);
      expect(() => s.transaction(() => Promise.resolve(1))).toThrow(/synchronous/);
      expect(s.transaction(() => 2)).toBe(2);
    });

    it("persists to a file and reopens read-only", () => {
      const dir = mkdtempSync(join(tmpdir(), "vtc-storage-"));
      dirs.push(dir);
      const path = join(dir, "index.sqlite");
      const w = open({ path });
      w.exec("CREATE TABLE t (v TEXT)");
      w.prepare("INSERT INTO t (v) VALUES (?)").run("x");
      w.close();
      const r = open({ path, readonly: true });
      opened.push(r);
      expect(r.prepare("SELECT v FROM t").all()).toEqual([{ v: "x" }]);
      expect(() => {
        r.exec("INSERT INTO t (v) VALUES ('y')");
      }).toThrow();
    });
  });
};
