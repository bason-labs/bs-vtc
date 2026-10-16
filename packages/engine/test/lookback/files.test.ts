import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readRoleWrittenText,
  withFileLock,
  writeRepoFileAtomic,
} from "../../src/lookback/files.js";
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

describe("writeRepoFileAtomic (repo-tracked Lookback outputs)", () => {
  it("creates the directories on the way and writes the file", async () => {
    const root = await tempDir("repo-write");
    await writeRepoFileAtomic(root, ".vtc/lookback/replays/routing/x.json", "{}\n");
    expect(await readFile(join(root, ".vtc/lookback/replays/routing/x.json"), "utf8")).toBe("{}\n");
  });

  it("writes nothing through a directory the repo commits as a symbolic link", async () => {
    const root = await tempDir("repo-write-link");
    const elsewhere = await tempDir("repo-write-elsewhere");
    await mkdir(join(root, ".vtc/lookback/replays"), { recursive: true });
    await symlink(elsewhere, join(root, ".vtc/lookback/replays/routing"));
    await expect(
      writeRepoFileAtomic(root, ".vtc/lookback/replays/routing/x.json", "{}\n"),
    ).rejects.toThrow(/not a directory of the repo/);
    expect(await readdir(elsewhere)).toEqual([]);
    // a link higher up is refused too
    const top = await tempDir("repo-write-top");
    await symlink(elsewhere, join(top, ".vtc"));
    await expect(writeRepoFileAtomic(top, ".vtc/lookback/a.json", "{}\n")).rejects.toThrow();
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("refuses a path that leaves the repo, and replaces a link at the file itself", async () => {
    const root = await tempDir("repo-write-file");
    await expect(writeRepoFileAtomic(root, "../x.json", "{}")).rejects.toThrow();
    const elsewhere = join(await tempDir("repo-write-target"), "kept.json");
    await writeFile(elsewhere, "kept\n");
    await symlink(elsewhere, join(root, "out.json"));
    await writeRepoFileAtomic(root, "out.json", "new\n");
    expect((await lstat(join(root, "out.json"))).isFile()).toBe(true);
    expect(await readFile(elsewhere, "utf8")).toBe("kept\n");
  });
});
