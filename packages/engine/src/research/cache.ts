/**
 * The research cache (spec §10, §14; AD-22 rule 2): `~/.vtc/research-cache/<scope>/`, one scope per
 * client (`researchScopeFor`), content-addressed blobs at `blobs/sha256/<hex>` and an append-only
 * index of `CacheEntry` lines. No lookup crosses scopes: every path is built from a validated
 * scope and SHA, so a request for one scope can never read another's files.
 *
 * Beside the index the cache keeps `requests.jsonl` (key → the `FetchRequest` that produced it),
 * so a stale fact can be re-fetched before G2 from the source its row records.
 */
import {
  CacheEntrySchema,
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
import { join } from "node:path";
import { appendLines, JsonlTail, readBytesIfExists, sha256Bytes, writeAtomic } from "./files.js";

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

export type FileResearchCache = ResearchCache & RequestMemory & CacheProvenance;

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
      if ((await readBytesIfExists(path)) === undefined) await writeAtomic(path, body);
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
