/**
 * The research cache (spec §10, §14; AD-22 rule 2): `~/.vtc/research-cache/<scope>/`, one scope per
 * client (`researchScopeFor`), content-addressed blobs at `blobs/sha256/<hex>` and an append-only
 * index of `CacheEntry` lines. No lookup crosses scopes: every path is built from a validated
 * scope and SHA, so a request for one scope can never read another's files.
 *
 * Beside the index the cache keeps `requests.jsonl` (key → the `FetchRequest` that produced it),
 * so a stale fact can be re-fetched before G2 from the source its row records.
 *
 * Eviction ({@link FileResearchCache.prune}) removes blobs only, never index lines: a blob no
 * index line names, or one whose every entry is superseded and older than the retention window
 * and that no caller-named fact cites. The index keeps the request and provenance of an evicted
 * blob, so a fetch of it is a plain miss and a fact citing it is re-fetched before G2.
 */
import {
  CacheEntrySchema,
  FETCHER_TTL_DAYS,
  FetchRequestSchema,
  parsePersisted,
  RESEARCH_CACHE,
  ResearchScopeSchema,
  Sha256HexSchema,
  type CacheEntry,
  type FetcherId,
  type FetchRequest,
  type ResearchCache,
  type ResearchScope,
} from "@vtc/shared";
import { readdir, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  appendLines,
  JsonlTail,
  parseJsonLines,
  readBytesIfExists,
  readTextIfExists,
  sha256Bytes,
  writeAtomic,
} from "./files.js";

/** The requests behind cached entries, for re-fetching a fact's source. */
export interface RequestMemory {
  remember(scope: ResearchScope, key: string, request: FetchRequest): Promise<void>;
  /** The request whose response from `fetcher` at `url` was stored as blob `content_sha256`. */
  recall(
    scope: ResearchScope,
    source: { readonly fetcher: FetcherId; readonly url: string; readonly content_sha256: string },
  ): Promise<FetchRequest | undefined>;
}

/**
 * What the cache itself recorded about a blob. The cache lives under the VTC home, out of a role's
 * reach, so this is the engine's own word on where a blob came from and when, unlike a row of the
 * git-tracked facts file.
 */
export interface CacheProvenance {
  /**
   * When `fetcher` last stored or revalidated blob `content_sha256` as its response from `url`
   * (the newest such index entry), or `undefined` when the index has none.
   */
  retrievedAt(
    scope: ResearchScope,
    source: { readonly fetcher: FetcherId; readonly url: string; readonly content_sha256: string },
  ): Promise<string | undefined>;
}

/** The longest freshness window of any fetcher: within it a superseded blob may still be cited. */
export const RESEARCH_CACHE_RETENTION_DAYS = Math.max(...Object.values(FETCHER_TTL_DAYS));

/** A blob or temp file younger than this is never removed: a `put` may be about to index it. */
export const RESEARCH_CACHE_PRUNE_GRACE_MS = 60 * 60_000;

export interface PruneOptions {
  readonly now: Date;
  /** Blob SHAs to keep whatever their age (the ones fact rows cite). */
  readonly keep?: Iterable<string>;
  /** Superseded entries younger than this many days keep their blob. */
  readonly retentionDays?: number;
}

export interface CachePruning {
  /** Removes unneeded blobs of `scope`; returns their SHAs. */
  prune(scope: ResearchScope, options: PruneOptions): Promise<{ readonly removed: string[] }>;
}

export type FileResearchCache = ResearchCache & RequestMemory & CacheProvenance & CachePruning;

const REQUESTS_FILE = "requests.jsonl";

export class CacheIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheIntegrityError";
  }
}

/** A cache under `<vtcHome>/research-cache/`. */
export const createFileResearchCache = (vtcHome: string): FileResearchCache => {
  const scopeDir = (scope: ResearchScope): string =>
    join(vtcHome, RESEARCH_CACHE.homeDir, ResearchScopeSchema.parse(scope));
  const blobPath = (scope: ResearchScope, sha: string): string =>
    join(scopeDir(scope), RESEARCH_CACHE.blobsDir, Sha256HexSchema.parse(sha));

  /**
   * The index and the request memory of each scope, kept in memory and brought up to date from
   * the files' new lines before each use ({@link JsonlTail}), so a lookup costs the lines appended
   * since the last one, not the whole history.
   */
  interface ScopeIndex {
    readonly entries: JsonlTail;
    readonly requestsFile: JsonlTail;
    /** The newest entry per key. */
    readonly byKey: Map<string, CacheEntry>;
    /** Per source (fetcher, URL, blob): its keys in index order and the newest retrieval. */
    readonly bySource: Map<string, { keys: string[]; newest: string }>;
    readonly requests: Map<string, FetchRequest>;
  }
  const indexes = new Map<ResearchScope, ScopeIndex>();
  const sourceKey = (s: {
    readonly fetcher: FetcherId;
    readonly url: string;
    readonly content_sha256: string;
  }): string => `${s.fetcher}\n${s.url}\n${s.content_sha256}`;

  const scopeIndex = async (scope: ResearchScope): Promise<ScopeIndex> => {
    const dir = scopeDir(scope);
    let index = indexes.get(scope);
    if (index === undefined) {
      index = {
        entries: new JsonlTail(join(dir, RESEARCH_CACHE.indexFile)),
        requestsFile: new JsonlTail(join(dir, REQUESTS_FILE)),
        byKey: new Map(),
        bySource: new Map(),
        requests: new Map(),
      };
      indexes.set(scope, index);
    }
    const entries = await index.entries.read();
    if (entries.reset) {
      index.byKey.clear();
      index.bySource.clear();
    }
    for (const value of entries.values) {
      const parsed = parsePersisted(CacheEntrySchema, value);
      if (!parsed.success) continue;
      const entry = parsed.data;
      index.byKey.set(entry.key, entry);
      const key = sourceKey(entry);
      const known = index.bySource.get(key);
      if (known === undefined) {
        index.bySource.set(key, { keys: [entry.key], newest: entry.retrieved_at });
      } else {
        known.keys.push(entry.key);
        if (Date.parse(entry.retrieved_at) > Date.parse(known.newest))
          known.newest = entry.retrieved_at;
      }
    }
    const requests = await index.requestsFile.read();
    if (requests.reset) index.requests.clear();
    for (const value of requests.values) {
      if (typeof value !== "object" || value === null) continue;
      const { key, request } = value as { key?: unknown; request?: unknown };
      const parsedKey = Sha256HexSchema.safeParse(key);
      const parsedRequest = FetchRequestSchema.safeParse(request);
      if (parsedKey.success && parsedRequest.success)
        index.requests.set(parsedKey.data, parsedRequest.data);
    }
    return index;
  };

  return {
    async get(scope, key) {
      const wanted = Sha256HexSchema.parse(key);
      return (await scopeIndex(scope)).byKey.get(wanted);
    },

    async put(scope, entry, body) {
      const valid = CacheEntrySchema.parse(entry);
      if (sha256Bytes(body) !== valid.content_sha256) {
        throw new CacheIntegrityError("the body does not have the entry's content_sha256");
      }
      const path = blobPath(scope, valid.content_sha256);
      const existing = await readBytesIfExists(path);
      if (existing === undefined || sha256Bytes(existing) !== valid.content_sha256) {
        // Missing, or tampered with: (re)write it.
        await writeAtomic(path, body);
      } else {
        // Touched, so a prune running now sees it as new and keeps it.
        const at = new Date();
        await utimes(path, at, at);
      }
      await appendLines(join(scopeDir(scope), RESEARCH_CACHE.indexFile), [JSON.stringify(valid)]);
    },

    async blob(scope, sha256) {
      const bytes = await readBytesIfExists(blobPath(scope, sha256));
      // A blob whose bytes no longer hash to its name was tampered with: never serve it.
      return bytes !== undefined && sha256Bytes(bytes) === sha256 ? bytes : undefined;
    },

    async remember(scope, key, request) {
      if ((await scopeIndex(scope)).requests.has(key)) return;
      await appendLines(join(scopeDir(scope), REQUESTS_FILE), [
        JSON.stringify({
          key: Sha256HexSchema.parse(key),
          request: FetchRequestSchema.parse(request),
        }),
      ]);
    },

    async retrievedAt(scope, source) {
      return (await scopeIndex(scope)).bySource.get(sourceKey(source))?.newest;
    },

    async prune(scope, options) {
      const dir = scopeDir(scope);
      const now = options.now.getTime();
      const retention = (options.retentionDays ?? RESEARCH_CACHE_RETENTION_DAYS) * 86_400_000;
      const needed = new Set<string>(options.keep ?? []);
      // The whole index, every line: the newest entry of each key, and any entry retrieved inside
      // the retention window, keeps its blob.
      const newest = new Map<string, CacheEntry>();
      const text = (await readTextIfExists(join(dir, RESEARCH_CACHE.indexFile))) ?? "";
      for (const { value } of parseJsonLines(text).values) {
        const parsed = parsePersisted(CacheEntrySchema, value);
        if (!parsed.success) continue;
        const entry = parsed.data;
        newest.set(entry.key, entry);
        if (now - Date.parse(entry.retrieved_at) < retention) needed.add(entry.content_sha256);
      }
      for (const entry of newest.values()) needed.add(entry.content_sha256);

      const blobs = join(dir, RESEARCH_CACHE.blobsDir);
      let names: string[];
      try {
        names = await readdir(blobs);
      } catch (error) {
        if ((error as { code?: unknown }).code === "ENOENT") return { removed: [] };
        throw error;
      }
      const removed: string[] = [];
      for (const name of names) {
        const isBlob = Sha256HexSchema.safeParse(name).success;
        const isTemp = name.endsWith(".tmp");
        if ((!isBlob && !isTemp) || (isBlob && needed.has(name))) continue;
        const path = join(blobs, name);
        let info;
        try {
          info = await stat(path);
        } catch {
          continue;
        }
        if (!info.isFile() || now - info.mtimeMs < RESEARCH_CACHE_PRUNE_GRACE_MS) continue;
        try {
          await unlink(path);
        } catch (error) {
          if ((error as { code?: unknown }).code === "ENOENT") continue;
          throw error;
        }
        if (isBlob) removed.push(name);
      }
      return { removed };
    },

    async recall(scope, source) {
      const index = await scopeIndex(scope);
      const keys = index.bySource.get(sourceKey(source))?.keys ?? [];
      for (let i = keys.length - 1; i >= 0; i -= 1) {
        const request = index.requests.get(keys[i] ?? "");
        if (request !== undefined) return request;
      }
      return undefined;
    },
  };
};
