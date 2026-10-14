/**
 * Research (spec §8.2, §10, §14; spine AD-22; lookback-research team). A leaf module: it imports
 * no other engine module and gets HTTP only from the injected `HttpClient`. The daemon builds a
 * {@link createResearchService} per project and serves its handlers as `ROLE_MCP_TOOLS`; engine
 * core asks it for the G2 fact list through an interface the daemon wires.
 */
export {
  CacheIntegrityError,
  createFileResearchCache,
  type CacheProvenance,
  type FileResearchCache,
  type RequestMemory,
} from "./cache.js";
export { scanResearchClaims, type DocumentClaim, type ResearchDocument } from "./claims.js";
export {
  appendFactRows,
  consistentFactRows,
  currentFacts,
  readFactRows,
  type FactsFile,
} from "./facts.js";
export {
  builtInFetchers,
  depsdevFetcher,
  eolFetcher,
  githubFetcher,
  osvFetcher,
  registryFetcher,
  rssFetcher,
  searchFetcher,
  webFetcher,
  youtubeFetcher,
} from "./fetchers.js";
export { htmlToMarkdown } from "./html.js";
export {
  cachedFetch,
  RESEARCH_HTTP_LIMITS,
  type CachedFetchContext,
  type CachedFetchSpec,
  type StoredBody,
} from "./http-fetch.js";
export { robotsAllows, robotsPatternMatches } from "./robots.js";
export {
  createResearchService,
  SEARCH_NOT_A_SOURCE,
  type G2Facts,
  type ResearchEventDraft,
  type ResearchService,
  type ResearchServiceDeps,
} from "./service.js";
export { roleFacingText, ROLE_TEXT_MAX_CHARS } from "./text.js";
