/**
 * The held git state's hash caches (D-cz) follow git's racy-clean rule: on a file system whose
 * timestamps are coarse (1–2 s on HFS+, FAT, some network or overlay file systems), a same-size
 * rewrite in the same tick as the last read leaves the stat unchanged, so a file changed within
 * 2 s of its read is read again rather than trusted from the cache.
 */
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupDirs, initRepo, writeFile } from "../helpers/repo.js";

/** Paths whose stat reports a coarse, fixed time (a 1 s file system that has not ticked). */
const coarse = { root: "", atMs: 0 };

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof fs>();
  const pin = (path: fs.PathLike, stat: fs.Stats): fs.Stats => {
    if (coarse.root === "" || !String(path).startsWith(coarse.root)) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat) as object) as fs.Stats, stat, {
      mtimeMs: coarse.atMs,
      ctimeMs: coarse.atMs,
    });
  };
  return {
    ...real,
    lstatSync: ((path: fs.PathLike, options?: fs.StatSyncOptions) =>
      pin(path, real.lstatSync(path, options) as fs.Stats)) as typeof real.lstatSync,
    statSync: ((path: fs.PathLike, options?: fs.StatSyncOptions) =>
      pin(path, real.statSync(path, options) as fs.Stats)) as typeof real.statSync,
  };
});

const { gitConfigFingerprint } = await import("../../src/git/git-config.js");

afterEach(() => {
  coarse.root = "";
  cleanupDirs();
});

describe("the held git state's caches (D-cz) and racily new files", () => {
  it("sees a same-size hook rewrite in the same timestamp tick", () => {
    const repo = initRepo();
    coarse.root = repo;
    coarse.atMs = Math.floor(Date.now() / 1000) * 1000;
    writeFile(repo, ".git/hooks/pre-commit", "#!/bin/sh\nexit 0\n");
    const before = gitConfigFingerprint(repo);
    writeFile(repo, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    const after = gitConfigFingerprint(repo);
    expect(after[".git/hooks/pre-commit"]).not.toBe(before[".git/hooks/pre-commit"]);
  });

  it("sees a same-size config rewrite in the same timestamp tick", () => {
    const repo = initRepo();
    coarse.root = repo;
    coarse.atMs = Math.floor(Date.now() / 1000) * 1000;
    const config = join(repo, ".git/config");
    fs.appendFileSync(config, "[alias]\n\tst = status\n");
    const before = gitConfigFingerprint(repo);
    const text = fs.readFileSync(config, "utf8");
    fs.writeFileSync(config, text.replace("st = status", "st = statux"));
    const after = gitConfigFingerprint(repo);
    expect(after[".git/config: alias.st"]).toBeDefined();
    expect(after[".git/config: alias.st"]).not.toBe(before[".git/config: alias.st"]);
  });
});
