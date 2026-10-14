/**
 * The built-in fetchers (spec §8.2, §10; AD-22). Each one turns a `FetchRequest` into one HTTP
 * request against a pinned public API and runs it through {@link cachedFetch}; none of them
 * touches the network except through the injected `HttpClient`.
 *
 * - `eol`: endoflife.date API v1; `depsdev`: deps.dev v3; `osv`: OSV `/v1/query`;
 * - `registry`: npm, PyPI and crates.io JSON; `github`: the GitHub REST API (unauthenticated, or
 *   with the user's own key for this fetcher);
 * - `web`: an HTTPS page after robots.txt allows it, stored as markdown; `rss`: a feed as is;
 * - `search` (`search.ts`): an optional keyed provider (H-3); with none configured it sends
 *   nothing and names the host's own web search;
 * - `youtube` (`youtube.ts`): a transcript through the user's own yt-dlp (reading 173).
 */
import type {
  FetchContext,
  Fetcher,
  FetcherId,
  FetchRequest,
  FetchResult,
  SearchProvider,
} from "@vtc/shared";
import { cachedFetch, RESEARCH_HTTP_LIMITS, type CachedFetchSpec } from "./http-fetch.js";
import { htmlToMarkdown } from "./html.js";
import type { FetchQuotaSlot } from "./quota.js";
import { robotsAllows, robotsProductToken } from "./robots.js";
import { createSearchFetcher } from "./search.js";
import { createYoutubeFetcher, userYtDlp, type YtDlp } from "./youtube.js";

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
 * redirects, the final URL's origin's robots.txt must allow its path too (within the origin as
 * across origins), or nothing is stored.
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
          if (final.href === target.href) return undefined;
          // robots.txt rules are per path: a redirect within the origin is checked too (its
          // robots.txt is already cached).
          return (await robotsAllowUrl(final, context))
            ? undefined
            : `${ROBOTS_DISALLOW} (after a redirect to ${
                final.origin === target.origin ? final.pathname : final.origin
              })`;
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
 * The `search` fetcher with no provider: it sends nothing and names the host's own web search
 * (H-3). The service builds the keyed one from `EngineDeps.researchSearchProvider`.
 */
export const searchFetcher: Fetcher = createSearchFetcher();

/** What the built-in fetchers take from the engine's wiring. */
export interface BuiltInFetcherOptions {
  /**
   * The keyed provider of the `search` fetcher (`EngineDeps.researchSearchProvider`; H-3: absent
   * by default, and then the fetcher sends nothing).
   */
  readonly searchProvider?: SearchProvider | undefined;
  /**
   * The yt-dlp the `youtube` fetcher runs (default: the user's own on `PATH`, never inside
   * `projectRoot`). Tests inject a fake.
   */
  readonly ytDlp?: YtDlp | undefined;
  /** The project root, where yt-dlp is never taken from. */
  readonly projectRoot?: string | undefined;
  /** The run's research quota: a yt-dlp run takes one request from it. */
  readonly quota?: FetchQuotaSlot | undefined;
}

/** Every built-in fetcher, by id. */
export const builtInFetchers = (
  options: BuiltInFetcherOptions = {},
): ReadonlyMap<FetcherId, Fetcher> =>
  new Map<FetcherId, Fetcher>(
    [
      eolFetcher,
      depsdevFetcher,
      osvFetcher,
      registryFetcher,
      githubFetcher,
      webFetcher,
      rssFetcher,
      createYoutubeFetcher({
        ytDlp:
          options.ytDlp ??
          userYtDlp(
            options.projectRoot === undefined ? undefined : [options.projectRoot, process.cwd()],
          ),
        quota: options.quota,
      }),
      createSearchFetcher(options.searchProvider),
    ].map((f) => [f.id, f]),
  );
