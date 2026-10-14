/**
 * The `search` fetcher (H-3, spine §5 reading 156; AD-22 rule 6). Research search runs on the
 * host's own web search in the Research Analyst's role session (`RoleTools.host_web`), with no VTC
 * API key and no extra bill. This fetcher is only an optional keyed provider the user opts into in
 * `~/.vtc/config.yaml` (`research.search_provider` and `research.api_keys.search`), with no
 * default: unless both the provider (`EngineDeps.researchSearchProvider`) and its key are set, it
 * sends nothing and answers unavailable, naming the host's own web search.
 *
 * Each provider is one request shape, checked against the vendor's official API reference on
 * 2026-10-14 (the URL is beside each). Results are snippets: a fact still needs the page itself,
 * so `fact_propose` keeps a fact sourced from `search` unverified.
 */
import type { Fetcher, FetchContext, FetchResult, SearchProvider } from "@vtc/shared";
import { cachedFetch } from "./http-fetch.js";

/** The search fetcher's version without a provider; a provider's results are keyed apart. */
export const SEARCH_FETCHER_VERSION = "2";

/** Why the `search` fetcher sent nothing: research search runs on the host (H-3). */
export const SEARCH_UNAVAILABLE_DETAIL =
  "no keyed search provider is configured: research search runs on the host's own web search in the Research Analyst's session (Claude Code WebSearch/WebFetch, Codex web search); to use a keyed provider instead, set research.search_provider and research.api_keys.search in ~/.vtc/config.yaml";

/** One provider's HTTP request for a query (the key goes only to that provider's API). */
interface SearchProviderSpec {
  readonly url: string;
  readonly headers: (key: string) => Readonly<Record<string, string>>;
  readonly body: (query: string, maxResults: number) => unknown;
}

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" } as const;

const PROVIDERS: Readonly<Record<SearchProvider, SearchProviderSpec>> = {
  // https://docs.tavily.com/documentation/api-reference/endpoint/search
  // POST https://api.tavily.com/search, `Authorization: Bearer <key>`, body `query` (required) and
  // `max_results` (0–20, default 10).
  tavily: {
    url: "https://api.tavily.com/search",
    headers: (key) => ({ ...JSON_HEADERS, authorization: `Bearer ${key}` }),
    body: (query, maxResults) => ({ query, max_results: maxResults }),
  },
  // https://exa.ai/docs/reference/search
  // POST https://api.exa.ai/search, `x-api-key: <key>`, body `query` (required) and `numResults`
  // (1–100, default 10).
  exa: {
    url: "https://api.exa.ai/search",
    headers: (key) => ({ ...JSON_HEADERS, "x-api-key": key }),
    body: (query, maxResults) => ({ query, numResults: maxResults }),
  },
};

/**
 * The URL a result without a provider names: nothing was sent, so it is no endpoint (`.invalid`,
 * RFC 2606, never resolves).
 */
export const NO_PROVIDER_URL = "https://host-web-search.invalid/";

const unavailable = (url: string, context: FetchContext): FetchResult => ({
  fetcher: "search",
  fetcher_version: SEARCH_FETCHER_VERSION,
  url,
  status: "error",
  cache: "miss",
  http_status: null,
  content_type: null,
  content_sha256: null,
  bytes: 0,
  retrieved_at: context.now().toISOString(),
  detail: SEARCH_UNAVAILABLE_DETAIL,
});

/**
 * The `search` fetcher over `provider` (`EngineDeps.researchSearchProvider`; absent: none). It
 * sends a request only when the provider is named and the user's key for `search` is set.
 */
export const createSearchFetcher = (provider?: SearchProvider): Fetcher => {
  const spec = provider === undefined ? undefined : PROVIDERS[provider];
  // the provider is part of the cache key, so one provider's results never answer for another's
  const version =
    provider === undefined ? SEARCH_FETCHER_VERSION : `${SEARCH_FETCHER_VERSION}-${provider}`;
  return {
    id: "search",
    version,
    async fetch(request, context) {
      if (request.fetcher !== "search")
        throw new TypeError(`the search fetcher got a ${request.fetcher} request`);
      if (spec === undefined) return unavailable(NO_PROVIDER_URL, context);
      const key = context.apiKey?.("search");
      if (key === undefined || key === "") return unavailable(spec.url, context);
      return cachedFetch(
        {
          fetcher: "search",
          version,
          request,
          url: spec.url,
          method: "POST",
          headers: spec.headers(key),
          body: JSON.stringify(spec.body(request.query, request.max_results)),
        },
        context,
      );
    },
  };
};
