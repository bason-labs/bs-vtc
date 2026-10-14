/**
 * The built-in fetchers (spec §8.2, §10; AD-22). Each one turns a `FetchRequest` into one HTTP
 * request against a pinned public API and runs it through {@link cachedFetch}; none of them
 * touches the network except through the injected `HttpClient`.
 *
 * - `eol`: endoflife.date API v1; `depsdev`: deps.dev v3; `osv`: OSV `/v1/query`;
 * - `registry`: npm, PyPI and crates.io JSON; `github`: the GitHub REST API (unauthenticated, or
 *   with the user's own key for this fetcher);
 * - `web`: an HTTPS page after robots.txt allows it, stored as markdown; `rss`: a feed as is;
 * - `search`: a keyed search API the user supplies (none configured: an error result);
 * - `youtube`: transcripts need the optional external yt-dlp tool, which this version does not
 *   run, so it answers with an error result.
 */
import type { FetchContext, Fetcher, FetcherId, FetchRequest, FetchResult } from "@vtc/shared";
import { cachedFetch, RESEARCH_HTTP_LIMITS, type CachedFetchSpec } from "./http-fetch.js";
import { htmlToMarkdown } from "./html.js";
import { robotsAllows, robotsProductToken } from "./robots.js";

type RequestOf<F extends FetcherId> = Extract<FetchRequest, { fetcher: F }>;

const enc = encodeURIComponent;

const JSON_ACCEPT = { accept: "application/json" } as const;

const unavailable = (
  id: FetcherId,
  version: string,
  url: string,
  context: FetchContext,
  detail: string,
): FetchResult => ({
  fetcher: id,
  fetcher_version: version,
  url,
  status: "error",
  cache: "miss",
  http_status: null,
  content_type: null,
  content_sha256: null,
  bytes: 0,
  retrieved_at: context.now().toISOString(),
  detail,
});

/** A fetcher that maps its request onto one HTTP call. */
const apiFetcher = <F extends FetcherId>(
  id: F,
  version: string,
  build: (
    request: RequestOf<F>,
    context: FetchContext,
  ) => Omit<CachedFetchSpec, "fetcher" | "version" | "request">,
): Fetcher => ({
  id,
  version,
  async fetch(request, context) {
    if (request.fetcher !== id)
      throw new TypeError(`the ${id} fetcher got a ${request.fetcher} request`);
    const spec = build(request as RequestOf<F>, context);
    return cachedFetch({ fetcher: id, version, request, ...spec }, context);
  },
});

export const eolFetcher = apiFetcher("eol", "1", (r) => ({
  url: `https://endoflife.date/api/v1/products/${enc(r.product)}/releases/${enc(r.release)}`,
  headers: JSON_ACCEPT,
}));

export const depsdevFetcher = apiFetcher("depsdev", "1", (r) => ({
  url:
    `https://api.deps.dev/v3/systems/${enc(r.system)}/packages/${enc(r.name)}` +
    (r.version === undefined ? "" : `/versions/${enc(r.version)}`),
  headers: JSON_ACCEPT,
}));

export const osvFetcher = apiFetcher("osv", "1", (r) => ({
  url: "https://api.osv.dev/v1/query",
  method: "POST",
  headers: { ...JSON_ACCEPT, "content-type": "application/json" },
  body: JSON.stringify({ package: { name: r.name, ecosystem: r.ecosystem }, version: r.version }),
}));

/** npm names a scoped package `@scope%2fname` in the registry path. */
const npmPath = (name: string): string =>
  name.startsWith("@") ? `@${enc(name.slice(1))}` : enc(name);

export const registryFetcher = apiFetcher("registry", "1", (r) => {
  const version = r.version === undefined ? "" : `/${enc(r.version)}`;
  switch (r.registry) {
    case "npm":
      return {
        url: `https://registry.npmjs.org/${npmPath(r.name)}${version}`,
        headers: JSON_ACCEPT,
      };
    case "pypi":
      return { url: `https://pypi.org/pypi/${enc(r.name)}${version}/json`, headers: JSON_ACCEPT };
    case "crates":
      return {
        url: `https://crates.io/api/v1/crates/${enc(r.name)}${version}`,
        headers: JSON_ACCEPT,
      };
  }
});

export const githubFetcher = apiFetcher("github", "1", (r, context) => {
  const [owner = "", repo = ""] = r.repo.split("/");
  const tail = r.what === "repo" ? "" : r.what === "releases" ? "/releases" : "/releases/latest";
  const key = context.apiKey?.("github");
  return {
    url: `https://api.github.com/repos/${enc(owner)}/${enc(repo)}${tail}`,
    headers: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(key === undefined || key === "" ? {} : { authorization: `Bearer ${key}` }),
    },
  };
});

export const rssFetcher = apiFetcher("rss", "1", (r) => ({
  url: r.url,
  headers: {
    accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.1",
  },
}));

const isHtml = (contentType: string | null): boolean =>
  contentType !== null && /\btext\/html\b|application\/xhtml\+xml/i.test(contentType);

const WEB_VERSION = "1";

/** Whether robots.txt of the URL's origin lets VTC fetch it (RFC 9309), through the cache. */
const robotsAllowUrl = async (target: URL, context: FetchContext): Promise<boolean> => {
  const robotsUrl = `${target.origin}/robots.txt`;
  const robots = await cachedFetch(
    {
      fetcher: "web",
      version: WEB_VERSION,
      request: { fetcher: "web", url: robotsUrl },
      url: robotsUrl,
      headers: { accept: "text/plain" },
      ttlDays: 1,
    },
    context,
  );
  // RFC 9309 §2.3.1: unreachable or a server error means "disallow all"; a 4xx means "allow all".
  if (robots.status === "ok" && robots.content_sha256 !== null) {
    const body = await context.cache.blob(context.scope, robots.content_sha256);
    const text = body === undefined ? "" : new TextDecoder().decode(body);
    const token = robotsProductToken(RESEARCH_HTTP_LIMITS.userAgent);
    return robotsAllows(text, token, `${target.pathname}${target.search}`);
  }
  return (
    robots.status === "not_found" ||
    (robots.http_status !== null && robots.http_status >= 400 && robots.http_status < 500)
  );
};

const ROBOTS_DISALLOW = "robots.txt disallows this page";

/**
 * The `web` fetcher: robots.txt first (RFC 9309), then the page, stored as markdown. When the page
 * redirects to another origin, that origin's robots.txt must allow the final URL too, or nothing
 * is stored.
 */
export const webFetcher: Fetcher = {
  id: "web",
  version: WEB_VERSION,
  async fetch(request, context) {
    if (request.fetcher !== "web")
      throw new TypeError(`the web fetcher got a ${request.fetcher} request`);
    let target: URL;
    try {
      target = new URL(request.url);
    } catch {
      return unavailable("web", WEB_VERSION, request.url, context, "not a URL");
    }
    if (!(await robotsAllowUrl(target, context))) {
      return {
        ...unavailable("web", WEB_VERSION, request.url, context, ROBOTS_DISALLOW),
        status: "blocked",
      };
    }
    return cachedFetch(
      {
        fetcher: "web",
        version: WEB_VERSION,
        request,
        url: request.url,
        headers: { accept: "text/html, text/plain;q=0.9, */*;q=0.1" },
        checkFinalUrl: async (finalUrl) => {
          const final = new URL(finalUrl);
          if (final.origin === target.origin) return undefined;
          return (await robotsAllowUrl(final, context))
            ? undefined
            : `${ROBOTS_DISALLOW} (after a redirect to ${final.origin})`;
        },
        transform: (body, contentType) =>
          isHtml(contentType)
            ? {
                body: new TextEncoder().encode(htmlToMarkdown(new TextDecoder().decode(body))),
                contentType: "text/markdown; charset=utf-8",
              }
            : { body, contentType },
      },
      context,
    );
  },
};

/**
 * The `search` fetcher over a keyed search API the user supplies (spec §10: Exa or Tavily). It
 * uses Tavily's `POST /search` with the user's key for this fetcher; without a key it answers
 * with an error result. Results are search snippets: a fact still needs the page itself, so
 * `fact_propose` keeps a fact sourced from `search` unverified (`SEARCH_NOT_A_SOURCE`).
 */
export const searchFetcher: Fetcher = {
  id: "search",
  version: "1",
  async fetch(request, context) {
    if (request.fetcher !== "search")
      throw new TypeError(`the search fetcher got a ${request.fetcher} request`);
    const url = "https://api.tavily.com/search";
    const key = context.apiKey?.("search");
    if (key === undefined || key === "") {
      return unavailable("search", this.version, url, context, "no search API key is configured");
    }
    return cachedFetch(
      {
        fetcher: "search",
        version: this.version,
        request,
        url,
        method: "POST",
        headers: {
          ...JSON_ACCEPT,
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify({ query: request.query, max_results: request.max_results }),
      },
      context,
    );
  },
};

/** The `youtube` fetcher: not available in this version (it needs the external yt-dlp tool). */
export const youtubeFetcher: Fetcher = {
  id: "youtube",
  version: "1",
  fetch(request, context) {
    if (request.fetcher !== "youtube")
      throw new TypeError(`the youtube fetcher got a ${request.fetcher} request`);
    return Promise.resolve(
      unavailable(
        "youtube",
        this.version,
        request.url,
        context,
        "video transcripts need the optional yt-dlp tool, which this version does not run",
      ),
    );
  },
};

/** Every built-in fetcher, by id. */
export const builtInFetchers = (): ReadonlyMap<FetcherId, Fetcher> =>
  new Map<FetcherId, Fetcher>(
    [
      eolFetcher,
      depsdevFetcher,
      osvFetcher,
      registryFetcher,
      githubFetcher,
      webFetcher,
      rssFetcher,
      youtubeFetcher,
      searchFetcher,
    ].map((f) => [f.id, f]),
  );
