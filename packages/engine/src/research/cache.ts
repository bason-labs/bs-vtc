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
import {
  appendLines,
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

export type FileResearchCache = ResearchCache & RequestMemory;

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

  const readIndex = async (scope: ResearchScope): Promise<CacheEntry[]> => {
    const text = await readTextIfExists(join(scopeDir(scope), RESEARCH_CACHE.indexFile));
    if (text === undefined) return [];
    const entries: CacheEntry[] = [];
    for (const { value } of parseJsonLines(text).values) {
      const parsed = parsePersisted(CacheEntrySchema, value);
      if (parsed.success) entries.push(parsed.data);
    }
    return entries;
  };

  const readRequests = async (scope: ResearchScope): Promise<Map<string, FetchRequest>> => {
    const text = await readTextIfExists(join(scopeDir(scope), REQUESTS_FILE));
    const map = new Map<string, FetchRequest>();
    if (text === undefined) return map;
    for (const { value } of parseJsonLines(text).values) {
      if (typeof value !== "object" || value === null) continue;
      const { key, request } = value as { key?: unknown; request?: unknown };
      const parsedKey = Sha256HexSchema.safeParse(key);
      const parsedRequest = FetchRequestSchema.safeParse(request);
      if (parsedKey.success && parsedRequest.success) map.set(parsedKey.data, parsedRequest.data);
    }
    return map;
  };

  return {
    async get(scope, key) {
      const wanted = Sha256HexSchema.parse(key);
      const entries = await readIndex(scope);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        if (entries[i]?.key === wanted) return entries[i];
      }
      return undefined;
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
      const known = await readRequests(scope);
      if (known.has(key)) return;
      await appendLines(join(scopeDir(scope), REQUESTS_FILE), [
        JSON.stringify({
          key: Sha256HexSchema.parse(key),
          request: FetchRequestSchema.parse(request),
        }),
      ]);
    },

    async recall(scope, source) {
      const entries = await readIndex(scope);
      const requests = await readRequests(scope);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (
          entry !== undefined &&
          entry.fetcher === source.fetcher &&
          entry.url === source.url &&
          entry.content_sha256 === source.content_sha256
        ) {
          const request = requests.get(entry.key);
          if (request !== undefined) return request;
        }
      }
      return undefined;
    },
  };
};
