import {
  canonicalCacheKey,
  FetchResultSchema,
  type FetchContext,
  type FetchRequestInput,
  FetchRequestSchema,
  HttpGuardError,
} from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  builtInFetchers,
  cachedFetch,
  createFileResearchCache,
  RESEARCH_HTTP_LIMITS,
  SEARCH_UNAVAILABLE_DETAIL,
  type CachedFetchContext,
} from "../../src/research/index.js";
import { clock, FixtureHttp, jsonResponse, respond, tempDir } from "./fixture-http.js";
import { guardNoNetwork } from "./no-network.js";

const EOL_URL = "https://endoflife.date/api/v1/products/nodejs/releases/22";
// no test runs yt-dlp: the youtube fetcher gets one that is never there
const fetchers = builtInFetchers({
  ytDlp: {
    locate: () => ({ available: false, reason: "yt-dlp is not installed (test)" }),
    run: () => Promise.reject(new Error("a test ran yt-dlp")),
  },
});

const setup = async (routes: ConstructorParameters<typeof FixtureHttp>[0] = {}) => {
  const http = new FixtureHttp(routes);
  const cache = createFileResearchCache(await tempDir("fetch"));
  const time = clock();
  const keys: Record<string, string> = {};
  const context: CachedFetchContext = {
    http,
    cache,
    requests: cache,
    scope: "_shared",
    now: time.now,
    apiKey: (name) => keys[name],
  };
  const run = async (input: FetchRequestInput, ctx: FetchContext = context) => {
    const request = FetchRequestSchema.parse(input);
    const fetcher = fetchers.get(request.fetcher);
    if (fetcher === undefined) throw new Error("no fetcher");
    return FetchResultSchema.parse(await fetcher.fetch(request, ctx));
  };
  return { http, cache, time, keys, context, run };
};

guardNoNetwork();

describe("cached fetch (RFC 9111 revalidation)", () => {
  it("fetches once, then serves a hit within the TTL", async () => {
    const { http, run } = await setup({
      [`GET ${EOL_URL}`]: jsonResponse(EOL_URL, { isEol: false }, { etag: '"v1"' }),
    });
    const first = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    expect(first).toMatchObject({ status: "ok", cache: "miss", http_status: 200 });
    expect(first.content_sha256).toMatch(/^[a-f0-9]{64}$/);
    const second = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    expect(second).toMatchObject({
      status: "ok",
      cache: "hit",
      content_sha256: first.content_sha256,
      // A hit reports when the content was fetched, not now: freshness never restarts on a hit.
      retrieved_at: first.retrieved_at,
    });
    expect(http.count(`GET ${EOL_URL}`)).toBe(1);
    expect(http.requests[0]?.headers?.["user-agent"]).toBe(RESEARCH_HTTP_LIMITS.userAgent);
  });

  it("revalidates a stale entry with a conditional request and keeps the blob on 304", async () => {
    const { http, time, run } = await setup({
      [`GET ${EOL_URL}`]: [
        jsonResponse(
          EOL_URL,
          { isEol: false },
          { etag: '"v1"', "last-modified": "Tue, 13 Oct 2026 08:00:00 GMT" },
        ),
        respond(EOL_URL, 304, "", { etag: '"v1"' }),
      ],
    });
    const first = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    time.advanceDays(8);
    const second = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    expect(second).toMatchObject({
      status: "ok",
      cache: "revalidated",
      content_sha256: first.content_sha256,
    });
    expect(second.retrieved_at).toBe(time.now().toISOString());
    const conditional = http.requests[1]?.headers ?? {};
    expect(conditional["if-none-match"]).toBe('"v1"');
    expect(conditional["if-modified-since"]).toBe("Tue, 13 Oct 2026 08:00:00 GMT");
    // Revalidated: fresh again, no third request.
    await run({ fetcher: "eol", product: "nodejs", release: "22" });
    expect(http.count(`GET ${EOL_URL}`)).toBe(2);
  });

  it("stores a changed body after the TTL as a new blob", async () => {
    const { time, run } = await setup({
      [`GET ${EOL_URL}`]: [
        jsonResponse(EOL_URL, { isEol: false }),
        jsonResponse(EOL_URL, { isEol: true }),
      ],
    });
    const first = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    time.advanceDays(8);
    const second = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    expect(second.cache).toBe("miss");
    expect(second.content_sha256).not.toBe(first.content_sha256);
  });

  it("serves a stale entry when the network fails, and an error when nothing is cached", async () => {
    const { http, time, run } = await setup({
      [`GET ${EOL_URL}`]: [jsonResponse(EOL_URL, { isEol: false }), new Error("ECONNRESET")],
    });
    const first = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    time.advanceDays(8);
    const stale = await run({ fetcher: "eol", product: "nodejs", release: "22" });
    expect(stale).toMatchObject({ status: "ok", cache: "stale", detail: "ECONNRESET" });
    expect(stale.retrieved_at).toBe(first.retrieved_at);
    http.set(`GET ${EOL_URL}`, respond(EOL_URL, 503, "busy"));
    time.advanceDays(1);
    expect((await run({ fetcher: "eol", product: "nodejs", release: "22" })).cache).toBe("stale");
    const none = await run({ fetcher: "eol", product: "nodejs", release: "20" });
    expect(none).toMatchObject({ status: "error", content_sha256: null });
  });

  it("reports not_found without storing anything", async () => {
    const url = "https://endoflife.date/api/v1/products/nodejs/releases/99";
    const { run } = await setup({ [`GET ${url}`]: respond(url, 404, "{}") });
    expect(await run({ fetcher: "eol", product: "nodejs", release: "99" })).toMatchObject({
      status: "not_found",
      http_status: 404,
      content_sha256: null,
    });
  });

  it("blocks plain http, a redirect off https and a body over the byte cap (network guard)", async () => {
    const { context } = await setup();
    const spec = {
      fetcher: "web" as const,
      version: "1",
      request: { fetcher: "web" as const, url: "https://example.com/" },
    };
    expect(await cachedFetch({ ...spec, url: "http://example.com/" }, context)).toMatchObject({
      status: "blocked",
    });

    const { context: redirected } = await setup({
      "GET https://example.com/a": respond("http://example.com/a", 200, "x"),
    });
    expect(await cachedFetch({ ...spec, url: "https://example.com/a" }, redirected)).toMatchObject({
      status: "blocked",
      detail: "a redirect left https",
    });

    const big = new Uint8Array(RESEARCH_HTTP_LIMITS.maxBytes + 1);
    const { context: huge } = await setup({
      "GET https://example.com/big": {
        status: 200,
        url: "https://example.com/big",
        headers: {},
        body: big,
      },
    });
    expect(await cachedFetch({ ...spec, url: "https://example.com/big" }, huge)).toMatchObject({
      status: "blocked",
    });
  });

  it("is unavailable without an HTTP client but still serves the cache", async () => {
    const { context, run } = await setup({
      [`GET ${EOL_URL}`]: jsonResponse(EOL_URL, { isEol: false }),
    });
    await run({ fetcher: "eol", product: "nodejs", release: "22" });
    const offline: FetchContext = {
      cache: context.cache,
      scope: "_shared",
      now: context.now,
      http: {
        request: () =>
          Promise.reject(new Error("no HTTP client: research fetchers are unavailable")),
      },
    };
    expect((await run({ fetcher: "eol", product: "nodejs", release: "22" }, offline)).cache).toBe(
      "hit",
    );
    expect(await run({ fetcher: "eol", product: "nodejs", release: "18" }, offline)).toMatchObject({
      status: "error",
      detail: "no HTTP client: research fetchers are unavailable",
    });
  });
});

describe("built-in fetchers", () => {
  it("encodes package names into the deps.dev, npm, PyPI and crates.io URLs", async () => {
    const depsdev =
      "https://api.deps.dev/v3/systems/npm/packages/%40colors%2Fcolors/versions/1.6.0";
    const npm = "https://registry.npmjs.org/@types%2Fnode/22.20.5";
    const pypi = "https://pypi.org/pypi/requests/json";
    const crates = "https://crates.io/api/v1/crates/serde/1.0.0";
    const { http, run } = await setup({
      [`GET ${depsdev}`]: jsonResponse(depsdev, {}),
      [`GET ${npm}`]: jsonResponse(npm, {}),
      [`GET ${pypi}`]: jsonResponse(pypi, {}),
      [`GET ${crates}`]: jsonResponse(crates, {}),
    });
    await run({ fetcher: "depsdev", system: "npm", name: "@colors/colors", version: "1.6.0" });
    await run({ fetcher: "registry", registry: "npm", name: "@types/node", version: "22.20.5" });
    await run({ fetcher: "registry", registry: "pypi", name: "requests" });
    await run({ fetcher: "registry", registry: "crates", name: "serde", version: "1.0.0" });
    expect(http.requests.map((r) => r.url)).toEqual([depsdev, npm, pypi, crates]);
  });

  it("queries OSV with a POST body", async () => {
    const url = "https://api.osv.dev/v1/query";
    const { http, run } = await setup({ [`POST ${url}`]: jsonResponse(url, { vulns: [] }) });
    const result = await run({
      fetcher: "osv",
      ecosystem: "npm",
      name: "lodash",
      version: "4.17.20",
    });
    expect(result.status).toBe("ok");
    expect(JSON.parse(http.requests[0]?.body ?? "")).toEqual({
      package: { name: "lodash", ecosystem: "npm" },
      version: "4.17.20",
    });
  });

  it("sends the user's own GitHub key only to GitHub", async () => {
    const url = "https://api.github.com/repos/nodejs/node/releases/latest";
    const { http, keys, run } = await setup({
      [`GET ${url}`]: jsonResponse(url, { tag_name: "v22.11.0" }),
    });
    keys.github = "ghp_fixture-token-value";
    await run({ fetcher: "github", repo: "nodejs/node", what: "latest_release" });
    expect(http.requests[0]?.headers?.authorization).toBe("Bearer ghp_fixture-token-value");
    expect(http.requests[0]?.headers?.cookie).toBeUndefined();
  });

  it("answers search without a provider, and youtube without yt-dlp, unavailable with no request", async () => {
    const { http, keys, run } = await setup();
    keys.search = "tvly-fixture-key-123";
    expect(await run({ fetcher: "search", query: "vitest 5 release" })).toMatchObject({
      status: "error",
      detail: SEARCH_UNAVAILABLE_DETAIL,
    });
    expect(
      await run({ fetcher: "youtube", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }),
    ).toMatchObject({
      status: "error",
      detail: expect.stringContaining("yt-dlp is not installed") as string,
    });
    expect(http.requests).toHaveLength(0);
  });
});

describe("web fetcher", () => {
  const page = "https://docs.example.com/guide/install?v=2";
  const robots = "https://docs.example.com/robots.txt";
  const html =
    "<html><head><title>x</title><script>alert(1)</script></head><body><nav>menu</nav>" +
    "<main><h1>Install</h1><p>Node.js 22 is supported until 2027-04-30.</p></main></body></html>";

  it("honours robots.txt before fetching the page", async () => {
    const { http, run } = await setup({
      [`GET ${robots}`]: respond(robots, 200, "User-agent: vtc-research\nDisallow: /guide/\n", {
        "content-type": "text/plain",
      }),
    });
    expect(await run({ fetcher: "web", url: page })).toMatchObject({
      status: "blocked",
      detail: "robots.txt disallows this page",
    });
    expect(http.count(`GET ${page}`)).toBe(0);
  });

  it("treats a missing robots.txt as allow-all and an unreachable one as disallow-all", async () => {
    const { http, cache, run } = await setup({
      [`GET ${robots}`]: respond(robots, 404, ""),
      [`GET ${page}`]: respond(page, 200, html, { "content-type": "text/html; charset=utf-8" }),
    });
    const result = await run({ fetcher: "web", url: page });
    expect(result).toMatchObject({ status: "ok", content_type: "text/markdown; charset=utf-8" });
    const stored = new TextDecoder().decode(
      await cache.blob("_shared", result.content_sha256 ?? ""),
    );
    expect(stored).toBe("# Install\n\nNode.js 22 is supported until 2027-04-30.");
    expect(http.count(`GET ${page}`)).toBe(1);

    const other = "https://down.example.com/a";
    const { http: http2, run: run2 } = await setup({
      "GET https://down.example.com/robots.txt": respond(
        "https://down.example.com/robots.txt",
        503,
        "",
      ),
    });
    expect((await run2({ fetcher: "web", url: other })).status).toBe("blocked");
    expect(http2.count(`GET ${other}`)).toBe(0);
  });

  it("re-checks robots.txt when the page redirects within its origin", async () => {
    const moved = new URL("/private/install", page).href;
    const { cache, run } = await setup({
      [`GET ${robots}`]: respond(robots, 200, "User-agent: *\nDisallow: /private\n", {
        "content-type": "text/plain",
      }),
      [`GET ${page}`]: respond(moved, 200, html, { "content-type": "text/html" }),
    });
    expect(await run({ fetcher: "web", url: page })).toMatchObject({
      status: "blocked",
      content_sha256: null,
      detail: "robots.txt disallows this page (after a redirect to /private/install)",
    });
    const key = canonicalCacheKey("1", FetchRequestSchema.parse({ fetcher: "web", url: page }));
    expect(await cache.get("_shared", key)).toBeUndefined();
  });

  it("re-checks robots.txt when the page redirects to another origin", async () => {
    const moved = "https://mirror.example.org/guide/install";
    const mirrorRobots = "https://mirror.example.org/robots.txt";
    const { cache, run } = await setup({
      [`GET ${robots}`]: respond(robots, 404, ""),
      [`GET ${page}`]: respond(moved, 200, html, { "content-type": "text/html" }),
      [`GET ${mirrorRobots}`]: respond(mirrorRobots, 200, "User-agent: *\nDisallow: /guide\n", {
        "content-type": "text/plain",
      }),
    });
    const result = await run({ fetcher: "web", url: page });
    expect(result).toMatchObject({
      status: "blocked",
      content_sha256: null,
      detail: "robots.txt disallows this page (after a redirect to https://mirror.example.org)",
    });
    // Nothing was stored for the page.
    const key = canonicalCacheKey("1", FetchRequestSchema.parse({ fetcher: "web", url: page }));
    expect(await cache.get("_shared", key)).toBeUndefined();
  });
});

describe("network guard refusals (AD-22 rule 1)", () => {
  it("reports a refusal by the client's guard (a private address) as blocked, never stale", async () => {
    const { http, time, run } = await setup({
      [`GET ${EOL_URL}`]: jsonResponse(EOL_URL, { isEol: false }),
    });
    await run({ fetcher: "eol", product: "nodejs", release: "22" });
    time.advanceDays(8);
    http.set(
      `GET ${EOL_URL}`,
      new HttpGuardError("endoflife.date resolves to a private address (10.0.0.5)", "guard"),
    );
    expect(await run({ fetcher: "eol", product: "nodejs", release: "22" })).toMatchObject({
      status: "blocked",
      content_sha256: null,
      detail: "endoflife.date resolves to a private address (10.0.0.5)",
    });
  });

  it("still serves stale on the client's timeout, which is not a refusal", async () => {
    const { http, time, run } = await setup({
      [`GET ${EOL_URL}`]: jsonResponse(EOL_URL, { isEol: false }),
    });
    await run({ fetcher: "eol", product: "nodejs", release: "22" });
    time.advanceDays(8);
    // Matched by its code, whatever the message says.
    http.set(`GET ${EOL_URL}`, new HttpGuardError("gave up waiting", "timeout"));
    expect((await run({ fetcher: "eol", product: "nodejs", release: "22" })).cache).toBe("stale");
  });
});
