import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendRepoJsonLines,
  readRoleWrittenText,
  withFileLock,
  writeRepoFileAtomic,
} from "../../src/lookback/files.js";
import { AttributionSchema } from "@vtc/shared";
import { appendAttributions, readAttributions } from "../../src/lookback/attribution.js";
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

describe("appendRepoJsonLines (a repo-tracked Lookback log, reading 249)", () => {
  it("creates the directories on the way and appends whole lines", async () => {
    const root = await tempDir("repo-append");
    await appendRepoJsonLines(root, ".vtc/lookback/attributions.jsonl", [{ a: 1 }]);
    await appendRepoJsonLines(root, ".vtc/lookback/attributions.jsonl", [{ a: 2 }, { a: 3 }]);
    expect(await readFile(join(root, ".vtc/lookback/attributions.jsonl"), "utf8")).toBe(
      '{"a":1}\n{"a":2}\n{"a":3}\n',
    );
  });

  it("appends nothing through a link at the file or a linked directory on the way", async () => {
    const root = await tempDir("repo-append-link");
    const outside = join(await tempDir("repo-append-outside"), ".zshrc");
    await writeFile(outside, "export PATH\n");
    await mkdir(join(root, ".vtc/lookback"), { recursive: true });
    await symlink(outside, join(root, ".vtc/lookback/attributions.jsonl"));
    await expect(
      appendRepoJsonLines(root, ".vtc/lookback/attributions.jsonl", [{ a: 1 }]),
    ).rejects.toThrow(/not a regular file of the repo/);
    expect(await readFile(outside, "utf8")).toBe("export PATH\n");

    const top = await tempDir("repo-append-top");
    const elsewhere = await tempDir("repo-append-elsewhere");
    await symlink(elsewhere, join(top, ".vtc"));
    await expect(
      appendRepoJsonLines(top, ".vtc/lookback/attributions.jsonl", [{ a: 1 }]),
    ).rejects.toThrow(/not a directory of the repo/);
    expect(await readdir(elsewhere)).toEqual([]);
  });

  it("is what Lookback appends attributions with, and reads them back without following a link", async () => {
    const root = await tempDir("repo-attributions");
    const outside = join(await tempDir("repo-attributions-outside"), "rc");
    await writeFile(outside, "user file\n");
    await mkdir(join(root, ".vtc/lookback"), { recursive: true });
    await symlink(outside, join(root, ".vtc/lookback/attributions.jsonl"));
    await expect(appendAttributions(root, [])).resolves.toBeUndefined();
    const row = AttributionSchema.parse({
      v: 1,
      trace: "a-1",
      run: "r1",
      prompt: {
        role: "engineer",
        host: "claude-code",
        effective_sha256: "1".repeat(64),
        locked_sha256: "2".repeat(64),
        editable_sha256: "3".repeat(64),
      },
      outcome: "failure",
      blamed_role: "engineer",
      method: "human",
      confidence: 1,
      split: "train",
      attributed_at: "2026-10-16T09:00:00.000Z",
    });
    await expect(appendAttributions(root, [row])).rejects.toThrow(/not a regular file/);
    expect(await readFile(outside, "utf8")).toBe("user file\n");
    // a linked attributions file is never read through: no rows
    await writeFile(outside, '{"not":"read"}\n');
    expect(await readAttributions(root, { history: [], lockedShaFor: () => undefined })).toEqual(
      [],
    );
  });
});
