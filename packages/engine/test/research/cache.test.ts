import { sha256Hex, type CacheEntry } from "@vtc/shared";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createFileResearchCache, CacheIntegrityError } from "../../src/research/index.js";
import { tempDir } from "./fixture-http.js";
import { guardNoNetwork } from "./no-network.js";

guardNoNetwork();

const body = new TextEncoder().encode('{"latest":"22.11.0"}');
const sha = sha256Hex('{"latest":"22.11.0"}');
const key = "a".repeat(64);

const entry = (over: Partial<CacheEntry> = {}): CacheEntry => ({
  v: 1,
  key,
  fetcher: "eol",
  fetcher_version: "1",
  url: "https://endoflife.date/api/v1/products/nodejs/releases/22",
  retrieved_at: "2026-10-14T10:00:00.000Z",
  ttl_s: 604_800,
  etag: '"abc"',
  http_status: 200,
  content_type: "application/json",
  content_sha256: sha,
  ...over,
});

describe("file research cache (AD-22 rule 2)", () => {
  it("stores content-addressed blobs and returns the newest entry of a key", async () => {
    const home = await tempDir("cache");
    const cache = createFileResearchCache(home);
    await cache.put("_shared", entry(), body);
    await cache.put("_shared", entry({ retrieved_at: "2026-10-15T10:00:00.000Z" }), body);
    expect((await cache.get("_shared", key))?.retrieved_at).toBe("2026-10-15T10:00:00.000Z");
    expect(await cache.blob("_shared", sha)).toEqual(body);
    const onDisk = await readFile(join(home, "research-cache", "_shared", "blobs", "sha256", sha));
    expect(new Uint8Array(onDisk)).toEqual(body);
  });

  it("never looks in another scope", async () => {
    const cache = createFileResearchCache(await tempDir("cache"));
    await cache.put("client-acme", entry(), body);
    expect(await cache.get("client-acme", key)).toBeDefined();
    expect(await cache.get("client-globex", key)).toBeUndefined();
    expect(await cache.get("_shared", key)).toBeUndefined();
    expect(await cache.blob("client-globex", sha)).toBeUndefined();
  });

  it("refuses a scope or SHA that could leave the cache directory", async () => {
    const cache = createFileResearchCache(await tempDir("cache"));
    await expect(cache.get("../client-acme", key)).rejects.toThrow();
    await expect(cache.blob("_shared", "../../etc/passwd")).rejects.toThrow();
  });

  it("refuses a body that does not match the entry's SHA and never serves a tampered blob", async () => {
    const home = await tempDir("cache");
    const cache = createFileResearchCache(home);
    await expect(cache.put("_shared", entry(), new TextEncoder().encode("other"))).rejects.toThrow(
      CacheIntegrityError,
    );
    await cache.put("_shared", entry(), body);
    await writeFile(join(home, "research-cache", "_shared", "blobs", "sha256", sha), "poisoned");
    expect(await cache.blob("_shared", sha)).toBeUndefined();
  });

  it("remembers the request behind an entry for re-fetching", async () => {
    const cache = createFileResearchCache(await tempDir("cache"));
    await cache.put("_shared", entry(), body);
    await cache.remember("_shared", key, { fetcher: "eol", product: "nodejs", release: "22" });
    const source = { fetcher: "eol" as const, url: entry().url, content_sha256: sha };
    expect(await cache.recall("_shared", source)).toEqual({
      fetcher: "eol",
      product: "nodejs",
      release: "22",
    });
    expect(await cache.recall("client-acme", source)).toBeUndefined();
  });
});
