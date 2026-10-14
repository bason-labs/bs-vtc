import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRoleWrittenText, withFileLock } from "../../src/lookback/files.js";
import { tempDir } from "./log.js";

describe("withFileLock (spine §5 reading 128)", () => {
  it("does not run fn while another writer holds a fresh lock, and leaves that lock in place", async () => {
    const lock = join(await tempDir("lock"), "pins.lock");
    await writeFile(lock, "the cli's token");
    let ran = false;
    const held = await withFileLock(lock, { staleMs: 60_000, waitMs: 120 }, () => {
      ran = true;
      return Promise.resolve(1);
    });
    expect(held).toBeUndefined();
    expect(ran).toBe(false);
    expect(await readFile(lock, "utf8")).toBe("the cli's token");
  });

  it("releases only its own lock: one replaced while fn ran stays", async () => {
    const lock = join(await tempDir("lock"), "pins.lock");
    const held = await withFileLock(lock, { staleMs: 60_000, waitMs: 120 }, async () => {
      await writeFile(lock, "a taker's token");
      return "done";
    });
    expect(held).toEqual({ value: "done" });
    expect(await readFile(lock, "utf8")).toBe("a taker's token");
  });
});

describe("readRoleWrittenText", () => {
  it("reads a file up to the cap and refuses one over it", async () => {
    const dir = await tempDir("guarded");
    await writeFile(join(dir, "ok.json"), "12345");
    await writeFile(join(dir, "big.json"), "123456");
    expect(await readRoleWrittenText(join(dir, "ok.json"), 5)).toEqual({
      kind: "text",
      text: "12345",
    });
    expect((await readRoleWrittenText(join(dir, "big.json"), 5)).kind).toBe("refused");
    expect((await readRoleWrittenText(join(dir, "none.json"), 5)).kind).toBe("missing");
  });
});
