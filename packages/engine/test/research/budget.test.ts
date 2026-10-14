import {
  FactRowSchema,
  RESEARCH_CACHE,
  RESEARCH_FACTS_FILE,
  sha256Hex,
  type CacheEntry,
} from "@vtc/shared";
import { readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFetchQuota,
  createFileResearchCache,
  createResearchService,
  RESEARCH_CACHE_RETENTION_DAYS,
} from "../../src/research/index.js";
import { clock, FixtureHttp, jsonResponse, tempDir } from "./fixture-http.js";
import { guardNoNetwork } from "./no-network.js";

guardNoNetwork();

const npmUrl = (version: string): string => `https://registry.npmjs.org/react/${version}`;
const npm = (version: string) =>
  ({ fetcher: "registry", registry: "npm", name: "react", version }) as const;

describe("research quota per run", () => {
  const setup = async (max: number) => {
    const routes: Record<string, ReturnType<typeof jsonResponse>> = {};
    for (const v of ["1.0.0", "2.0.0", "3.0.0"]) {
      routes[`GET ${npmUrl(v)}`] = jsonResponse(npmUrl(v), { license: "MIT" });
    }
    const http = new FixtureHttp(routes);
    const vtcHome = await tempDir("quota-home");
    const projectRoot = await tempDir("quota-project");
    const cache = createFileResearchCache(vtcHome);
    const quota = createFetchQuota(max);
    const time = clock();
    const serviceFor = (run: string | undefined) =>
      createResearchService({
        projectRoot,
        cache,
        scope: "_shared",
        http,
        now: time.now,
        ...(run === undefined ? {} : { quota: quota.forRun(run) }),
      });
    return { http, quota, serviceFor, time };
  };

  it("blocks a run's network requests past its quota and still serves the cache", async () => {
    const { http, quota, serviceFor } = await setup(2);
    // The daemon builds a service per call: the quota lives across them.
    expect((await serviceFor("r-1").researchFetch({ request: npm("1.0.0") })).result.status).toBe(
      "ok",
    );
    expect((await serviceFor("r-1").researchFetch({ request: npm("2.0.0") })).result.status).toBe(
      "ok",
    );
    const over = await serviceFor("r-1").researchFetch({ request: npm("3.0.0") });
    expect(over.result).toMatchObject({ status: "blocked", cache: "miss" });
    expect(over.result.detail).toContain("quota");
    expect(http.count(`GET ${npmUrl("3.0.0")}`)).toBe(0);
    expect(quota.used("r-1")).toBe(2);

    // A cached answer costs no network request, so it is served past the quota.
    const cached = await serviceFor("r-1").researchFetch({ request: npm("1.0.0") });
    expect(cached.result).toMatchObject({ status: "ok", cache: "hit" });

    // fact_propose fetches through the same quota.
    const proposed = await serviceFor("r-1").factPropose(
      {
        subject: "npm:react@3.0.0",
        predicate: "license",
        value: "MIT",
        source: { request: npm("3.0.0"), locator: { kind: "json_pointer", pointer: "/license" } },
      },
      "architect",
    );
    expect(proposed.fact.status).toBe("unverified");
  });

  it("counts each run on its own and leaves engine fetches (G2) out", async () => {
    const { http, serviceFor } = await setup(1);
    await serviceFor("r-1").researchFetch({ request: npm("1.0.0") });
    expect((await serviceFor("r-2").researchFetch({ request: npm("2.0.0") })).result.status).toBe(
      "ok",
    );
    expect((await serviceFor(undefined).fetch(npm("3.0.0"))).result.status).toBe("ok");
    expect(http.count(`GET ${npmUrl("3.0.0")}`)).toBe(1);
  });

  it("refuses a quota that is not a positive integer", () => {
    expect(() => createFetchQuota(0)).toThrow();
    expect(() => createFetchQuota(1.5)).toThrow();
  });
});

const DAY = 86_400_000;

const entry = (over: Partial<CacheEntry> & Pick<CacheEntry, "key" | "content_sha256">) =>
  ({
    v: 1,
    fetcher: "registry",
    fetcher_version: "1",
    url: npmUrl("1.0.0"),
    retrieved_at: "2026-10-14T10:00:00.000Z",
    ttl_s: 86_400,
    http_status: 200,
    content_type: "application/json",
    ...over,
  }) as CacheEntry;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe("research cache eviction", () => {
  const blobsDir = (home: string, scope = "_shared"): string =>
    join(home, RESEARCH_CACHE.homeDir, scope, RESEARCH_CACHE.blobsDir);

  const age = async (path: string, at: Date): Promise<void> => {
    await utimes(path, at, at);
  };

  it("removes unreferenced and superseded old blobs and keeps what may still be cited", async () => {
    const home = await tempDir("prune");
    const cache = createFileResearchCache(home);
    // Real time: the prune compares file mtimes with it.
    const now = new Date();
    const long = new Date(now.getTime() - (RESEARCH_CACHE_RETENTION_DAYS + 5) * DAY);
    const recent = new Date(now.getTime() - 2 * DAY);
    const key1 = "1".repeat(64);
    const key2 = "2".repeat(64);
    const [oldA, newA, recentOld, kept, orphan, freshOrphan] = [
      "old a",
      "new a",
      "recent superseded",
      "cited by a fact",
      "orphan",
      "fresh orphan",
    ];
    const sha = (text: string): string => sha256Hex(text);
    // key1: a superseded entry long ago, then the newest one.
    await cache.put(
      "_shared",
      entry({ key: key1, content_sha256: sha(oldA), retrieved_at: long.toISOString() }),
      bytes(oldA),
    );
    await cache.put(
      "_shared",
      entry({ key: key1, content_sha256: sha(newA), retrieved_at: recent.toISOString() }),
      bytes(newA),
    );
    // key2: superseded only recently (inside the retention window), then a long-gone kept one.
    await cache.put(
      "_shared",
      entry({ key: key2, content_sha256: sha(kept), retrieved_at: long.toISOString() }),
      bytes(kept),
    );
    await cache.put(
      "_shared",
      entry({ key: key2, content_sha256: sha(recentOld), retrieved_at: recent.toISOString() }),
      bytes(recentOld),
    );
    await cache.put(
      "_shared",
      entry({ key: key2, content_sha256: sha(newA), retrieved_at: recent.toISOString() }),
      bytes(newA),
    );
    const dir = blobsDir(home);
    await writeFile(join(dir, sha(orphan)), orphan);
    await writeFile(join(dir, sha(freshOrphan)), freshOrphan);
    await writeFile(join(dir, `${sha(orphan)}.abc123.tmp`), "torn");
    await writeFile(join(dir, "README"), "not a blob");
    for (const name of await readdir(dir)) {
      if (name !== sha(freshOrphan)) await age(join(dir, name), long);
    }

    const result = await cache.prune("_shared", { now, keep: [sha(kept)] });
    expect([...result.removed].sort()).toEqual([sha(oldA), sha(orphan)].sort());
    const left = await readdir(dir);
    expect(left.sort()).toEqual(
      [sha(newA), sha(recentOld), sha(kept), sha(freshOrphan), "README"].sort(),
    );
    // The index is untouched: the newest entry still serves.
    expect(await cache.blob("_shared", sha(newA))).toEqual(bytes(newA));
  });

  it("never touches another scope", async () => {
    const home = await tempDir("prune-scope");
    const cache = createFileResearchCache(home);
    const orphan = "client orphan";
    await cache.put(
      "client-acme",
      entry({ key: "3".repeat(64), content_sha256: sha256Hex("x") }),
      bytes("x"),
    );
    const path = join(blobsDir(home, "client-acme"), sha256Hex(orphan));
    await writeFile(path, orphan);
    await age(path, new Date("2020-01-01T00:00:00.000Z"));
    const result = await cache.prune("_shared", { now: new Date() });
    expect(result.removed).toEqual([]);
    expect(await readFile(path, "utf8")).toBe(orphan);
  });

  it("refreshes the mtime of a blob a put stores again, so a racing prune keeps it", async () => {
    const home = await tempDir("prune-touch");
    const cache = createFileResearchCache(home);
    const text = "body";
    const e = entry({ key: "4".repeat(64), content_sha256: sha256Hex(text) });
    await cache.put("_shared", e, bytes(text));
    const path = join(blobsDir(home), sha256Hex(text));
    await age(path, new Date("2020-01-01T00:00:00.000Z"));
    await cache.put("_shared", e, bytes(text));
    const { mtimeMs } = await stat(path);
    expect(mtimeMs).toBeGreaterThan(Date.parse("2025-01-01T00:00:00.000Z"));
  });

  it("rewrites a tampered blob when the same content is stored again", async () => {
    const home = await tempDir("prune-tamper");
    const cache = createFileResearchCache(home);
    const text = "body";
    const e = entry({ key: "5".repeat(64), content_sha256: sha256Hex(text) });
    await cache.put("_shared", e, bytes(text));
    await writeFile(join(blobsDir(home), sha256Hex(text)), "poisoned");
    expect(await cache.blob("_shared", sha256Hex(text))).toBeUndefined();
    await cache.put("_shared", e, bytes(text));
    expect(await cache.blob("_shared", sha256Hex(text))).toEqual(bytes(text));
  });
});

describe("the service's cache prune", () => {
  it("keeps every blob a fact row of the project cites", async () => {
    const url = npmUrl("1.0.0");
    const http = new FixtureHttp({
      [`GET ${url}`]: [
        jsonResponse(url, { license: "MIT" }),
        jsonResponse(url, { license: "Apache-2.0" }),
      ],
    });
    const home = await tempDir("svc-prune-home");
    const cache = createFileResearchCache(home);
    const time = clock(new Date(Date.now() - 400 * DAY).toISOString());
    const service = createResearchService({
      projectRoot: await tempDir("svc-prune-project"),
      cache,
      scope: "_shared",
      http,
      now: time.now,
    });
    const propose = (value: string) =>
      service.factPropose(
        {
          subject: "npm:react@1.0.0",
          predicate: "license",
          value,
          source: { request: npm("1.0.0"), locator: { kind: "json_pointer", pointer: "/license" } },
        },
        "architect",
      );
    const first = (await propose("MIT")).fact;
    time.advanceDays(2);
    const second = (await propose("Apache-2.0")).fact;
    expect(second.source?.content_sha256).not.toBe(first.source?.content_sha256);
    // Back to the present: both entries are far outside the retention window now.
    time.advanceDays(398);
    const firstSha = first.source?.content_sha256 ?? "";
    const dir = join(home, RESEARCH_CACHE.homeDir, "_shared", RESEARCH_CACHE.blobsDir);
    const long = new Date(Date.now() - 400 * DAY);
    for (const name of await readdir(dir)) await utimes(join(dir, name), long, long);

    const result = await service.pruneCache();
    expect(result.removed).toEqual([]);
    expect((await readdir(dir)).sort()).toEqual(
      [firstSha, second.source?.content_sha256 ?? ""].sort(),
    );
  });
});

describe("a fact whose blob was evicted", () => {
  it("is stale to fact_lookup and re-fetched before G2", async () => {
    const url = npmUrl("1.0.0");
    const http = new FixtureHttp({ [`GET ${url}`]: jsonResponse(url, { license: "MIT" }) });
    const home = await tempDir("evicted-home");
    const projectRoot = await tempDir("evicted-project");
    const cache = createFileResearchCache(home);
    const time = clock();
    const service = createResearchService({
      projectRoot,
      cache,
      scope: "_shared",
      http,
      now: time.now,
    });
    const { fact } = await service.factPropose(
      {
        subject: "npm:react@1.0.0",
        predicate: "license",
        value: "MIT",
        source: { request: npm("1.0.0"), locator: { kind: "json_pointer", pointer: "/license" } },
      },
      "architect",
    );
    expect(fact.status).toBe("verified");
    const blob = join(
      home,
      RESEARCH_CACHE.homeDir,
      "_shared",
      RESEARCH_CACHE.blobsDir,
      fact.source?.content_sha256 ?? "",
    );
    await rm(blob);

    const looked = await service.factLookup({ ids: [fact.id] });
    expect(looked.facts[0]?.status).toBe("stale");

    const g2 = await service.g2Facts([]);
    expect(g2.unverified_facts).toEqual([]);
    expect(http.count(`GET ${url}`)).toBe(2);
    const rows = (await readFile(join(projectRoot, RESEARCH_FACTS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => FactRowSchema.parse(JSON.parse(line)));
    expect(rows.at(-1)).toMatchObject({ id: fact.id, status: "verified", recorded_by: "engine" });
  });
});
