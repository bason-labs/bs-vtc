/**
 * H-3 (spine §5 reading 156): the `search` fetcher is an optional keyed provider with no default.
 * D-bs (reading 173): the `youtube` fetcher runs the user's own yt-dlp. Every yt-dlp here is a
 * fake: no test runs it, and no test opens a socket.
 */
import {
  FetchRequestSchema,
  FetchResultSchema,
  type FetchRequestInput,
  type SearchProvider,
} from "@vtc/shared";
import { chmod, mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileResearchCache,
  createResearchService,
  createSearchFetcher,
  createYoutubeFetcher,
  createFetchQuota,
  SEARCH_UNAVAILABLE_DETAIL,
  vttToText,
  youtubeVideoId,
  ytDlpArgs,
  ytDlpAvailable,
  type CachedFetchContext,
  type YtDlp,
  type YtDlpRun,
} from "../../src/research/index.js";
import { clock, FixtureHttp, jsonResponse, respond, tempDir } from "./fixture-http.js";
import { guardNoNetwork } from "./no-network.js";

guardNoNetwork();

const context = async (keys: Record<string, string> = {}, http = new FixtureHttp()) => {
  const cache = createFileResearchCache(await tempDir("sy-home"));
  const time = clock();
  const ctx: CachedFetchContext = {
    http,
    cache,
    requests: cache,
    scope: "_shared",
    now: time.now,
    apiKey: (name) => keys[name],
  };
  return { ctx, http, cache, time };
};

describe("the search fetcher (H-3: no default provider)", () => {
  const request = FetchRequestSchema.parse({ fetcher: "search", query: "node 22 eol" });

  it("sends nothing without a provider, even with a key, and names the host's web search", async () => {
    const { ctx, http } = await context({ search: "tvly-fixture-key-123" });
    const result = FetchResultSchema.parse(await createSearchFetcher().fetch(request, ctx));
    expect(result).toMatchObject({ status: "error", content_sha256: null });
    expect(result.detail).toBe(SEARCH_UNAVAILABLE_DETAIL);
    expect(result.detail).toContain("host's own web search");
    expect(http.requests).toHaveLength(0);
  });

  it("sends nothing with a provider but no key", async () => {
    for (const provider of ["tavily", "exa"] as const) {
      const { ctx, http } = await context();
      const result = await createSearchFetcher(provider).fetch(request, ctx);
      expect(result).toMatchObject({ status: "error", detail: SEARCH_UNAVAILABLE_DETAIL });
      expect(http.requests).toHaveLength(0);
    }
  });

  const cases: readonly {
    provider: SearchProvider;
    url: string;
    auth: Record<string, string>;
    body: unknown;
  }[] = [
    {
      provider: "tavily",
      url: "https://api.tavily.com/search",
      auth: { authorization: "Bearer key-fixture-0000" },
      body: { query: "node 22 eol", max_results: 3 },
    },
    {
      provider: "exa",
      url: "https://api.exa.ai/search",
      auth: { "x-api-key": "key-fixture-0000" },
      body: { query: "node 22 eol", numResults: 3 },
    },
  ];
  for (const c of cases) {
    it(`queries ${c.provider} as its API reference documents, with the key only there`, async () => {
      const http = new FixtureHttp({ [`POST ${c.url}`]: jsonResponse(c.url, { results: [] }) });
      const { ctx } = await context({ search: "key-fixture-0000" }, http);
      const result = await createSearchFetcher(c.provider).fetch(
        FetchRequestSchema.parse({ fetcher: "search", query: "node 22 eol", max_results: 3 }),
        ctx,
      );
      expect(result).toMatchObject({ status: "ok", fetcher_version: `2-${c.provider}` });
      expect(http.requests).toHaveLength(1);
      expect(http.requests[0]?.headers).toMatchObject(c.auth);
      expect(JSON.parse(http.requests[0]?.body ?? "")).toEqual(c.body);
    });
  }

  it("is keyed by EngineDeps.researchSearchProvider through the service", async () => {
    const url = "https://api.exa.ai/search";
    const http = new FixtureHttp({ [`POST ${url}`]: jsonResponse(url, { results: [] }) });
    const deps = {
      projectRoot: await tempDir("sy-project"),
      cache: createFileResearchCache(await tempDir("sy-home")),
      scope: "_shared",
      http,
      now: clock().now,
      apiKey: (name: string) => (name === "search" ? "key-fixture-0000" : undefined),
    } as const;
    const off = createResearchService(deps);
    expect((await off.fetch({ fetcher: "search", query: "q" })).result.status).toBe("error");
    expect(http.requests).toHaveLength(0);
    const on = createResearchService({ ...deps, searchProvider: "exa" });
    expect((await on.fetch({ fetcher: "search", query: "q" })).result.status).toBe("ok");
    expect(http.requests).toHaveLength(1);
  });
});

describe("fact_propose with a host-reported source (H-3)", () => {
  const PAGE = "https://nodejs.org/en/about/previous-releases";
  const ROBOTS = "https://nodejs.org/robots.txt";
  const reported = {
    url: PAGE,
    via: "host_search",
    query: "node 22 end of life",
  } as const;

  const setup = async (routes: ConstructorParameters<typeof FixtureHttp>[0] = {}) => {
    const http = new FixtureHttp(routes);
    const service = createResearchService({
      projectRoot: await tempDir("sy-project"),
      cache: createFileResearchCache(await tempDir("sy-home")),
      scope: "_shared",
      http,
      now: clock().now,
    });
    return { http, service };
  };

  it("records a claim with no source as unverified and keeps reported_source, fetching nothing", async () => {
    const { http, service } = await setup();
    const { fact } = await service.factPropose(
      {
        subject: "nodejs@22",
        predicate: "eol_date",
        value: "2027-04-30",
        source: null,
        reported_source: reported,
      },
      "research_analyst",
    );
    expect(fact).toMatchObject({ status: "unverified", source: null, reported_source: reported });
    expect(http.requests).toHaveLength(0);
    const g2 = await service.g2Facts([]);
    expect(g2.facts).toMatchObject([
      {
        id: fact.id,
        status: "unverified",
        source_url: PAGE,
        reason: expect.stringContaining("UNVERIFIED") as string,
      },
    ]);
  });

  it("records the same claim again when another page reports it", async () => {
    const { service } = await setup();
    const input = {
      subject: "nodejs@22",
      predicate: "eol_date",
      value: "2027-04-30",
      source: null,
      reported_source: reported,
    } as const;
    const first = await service.factPropose(input, "research_analyst");
    const again = await service.factPropose(input, "research_analyst");
    expect(again.fact).toEqual(first.fact);
    const other = await service.factPropose(
      { ...input, reported_source: { url: "https://endoflife.date/nodejs", via: "host_fetch" } },
      "research_analyst",
    );
    expect(other.fact.reported_source?.url).toBe("https://endoflife.date/nodejs");
  });

  it("verifies through a web source request and keeps reported_source on the row", async () => {
    const { http, service } = await setup({
      [`GET ${ROBOTS}`]: respond(ROBOTS, 404, ""),
      [`GET ${PAGE}`]: respond(
        PAGE,
        200,
        "<main><p>Node.js 22 reaches end of life on 2027-04-30.</p></main>",
        { "content-type": "text/html" },
      ),
    });
    const { fact } = await service.factPropose(
      {
        subject: "nodejs@22",
        predicate: "eol_date",
        value: "2027-04-30",
        source: {
          request: { fetcher: "web", url: PAGE },
          locator: { kind: "quote", text: "Node.js 22 reaches end of life on 2027-04-30." },
        },
        reported_source: reported,
      },
      "research_analyst",
    );
    expect(fact).toMatchObject({
      status: "verified",
      source: { fetcher: "web", url: PAGE },
      reported_source: reported,
    });
    expect(http.count(`GET ${PAGE}`)).toBe(1);
  });
});

// ------------------------------------------------------------------------- youtube

const VIDEO = "dQw4w9WgXcQ";
const WATCH = `https://www.youtube.com/watch?v=${VIDEO}`;

const VTT = `WEBVTT
Kind: captions
Language: en

1
00:00:00.000 --> 00:00:02.000 align:start position:0%
Node 22 is <c>the</c> LTS line

00:00:02.000 --> 00:00:04.000
Node 22 is the LTS line
until April 2027 &amp; beyond

NOTE a comment
that spans lines

00:00:04.000 --> 00:00:06.000
token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked
`;

interface FakeCall {
  readonly binary: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

const fakeYtDlp = (
  behaviour: (
    call: FakeCall,
  ) => Promise<{ exitCode: number | null; timedOut: boolean; stderr: string }>,
  tempRoot?: string,
): YtDlp & { calls: FakeCall[] } => {
  const calls: FakeCall[] = [];
  const run: YtDlpRun = async (binary, args, options) => {
    const call = { binary, args, ...options };
    calls.push(call);
    return behaviour(call);
  };
  return {
    calls,
    locate: () => ({ available: true, path: "/opt/tools/bin/yt-dlp" }),
    run,
    ...(tempRoot === undefined ? {} : { tempRoot }),
  };
};

/** A fake that writes subtitles where yt-dlp would (`--paths <dir>`, `transcript.<lang>.vtt`). */
const writesSubtitles = (files: Record<string, string>) => async (call: FakeCall) => {
  const dir = call.args[call.args.indexOf("--paths") + 1] ?? "";
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return { exitCode: 0, timedOut: false, stderr: "" };
};

const youtube = async (
  ytDlp: YtDlp,
  extra: { quota?: ReturnType<ReturnType<typeof createFetchQuota>["forRun"]> } = {},
) => {
  const { ctx, time, cache, http } = await context();
  const fetcher = createYoutubeFetcher({ ytDlp, ...extra });
  const run = async (input: FetchRequestInput) =>
    FetchResultSchema.parse(await fetcher.fetch(FetchRequestSchema.parse(input), ctx));
  return { run, time, cache, http, ctx };
};

describe("the youtube fetcher through the user's yt-dlp (D-bs)", () => {
  it("runs yt-dlp with an argv array, a timeout and a fresh temp dir, and caches a redacted transcript", async () => {
    const tempRoot = await tempDir("sy-tmp");
    const ytDlp = fakeYtDlp(writesSubtitles({ "transcript.en.vtt": VTT }), tempRoot);
    const { run, cache } = await youtube(ytDlp);
    const result = await run({ fetcher: "youtube", url: `https://youtu.be/${VIDEO}?t=42` });
    expect(result).toMatchObject({ status: "ok", cache: "miss", url: WATCH });
    expect(ytDlp.calls).toHaveLength(1);
    const call = ytDlp.calls[0];
    expect(call?.binary).toBe("/opt/tools/bin/yt-dlp");
    expect(call?.args).toEqual(ytDlpArgs(WATCH, call?.cwd ?? ""));
    expect(call?.args).toEqual(
      expect.arrayContaining([
        "--ignore-config",
        "--no-cookies",
        "--no-cookies-from-browser",
        "--skip-download",
      ]),
    );
    expect(call?.args.at(-1)).toBe(WATCH);
    expect(call?.args.at(-2)).toBe("--");
    expect(call?.timeoutMs).toBeGreaterThan(0);
    expect(call?.cwd.startsWith(join(tempRoot, "vtc-yt-dlp-"))).toBe(true);
    expect(call?.env.HOME).toBe(call?.cwd);
    // the temporary directory is gone
    expect(await readdir(tempRoot)).toEqual([]);
    const body = new TextDecoder().decode(await cache.blob("_shared", result.content_sha256 ?? ""));
    expect(body).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(body.startsWith("Node 22 is the LTS line\nuntil April 2027 & beyond\ntoken ")).toBe(
      true,
    );
  });

  it("serves the cached transcript within the TTL without running yt-dlp again", async () => {
    const ytDlp = fakeYtDlp(writesSubtitles({ "transcript.en.vtt": VTT }));
    const { run } = await youtube(ytDlp);
    await run({ fetcher: "youtube", url: WATCH });
    expect(await run({ fetcher: "youtube", url: WATCH })).toMatchObject({ cache: "hit" });
    expect(ytDlp.calls).toHaveLength(1);
  });

  it("answers unavailable with a visible reason when yt-dlp is absent", async () => {
    const ytDlp: YtDlp = {
      locate: () => ({ available: false, reason: "yt-dlp was not found on PATH" }),
      run: () => Promise.reject(new Error("must not run")),
    };
    const { run } = await youtube(ytDlp);
    expect(await run({ fetcher: "youtube", url: WATCH })).toMatchObject({
      status: "error",
      content_sha256: null,
      detail: expect.stringContaining("yt-dlp was not found on PATH") as string,
    });
  });

  it("refuses a URL that is not a YouTube video, without running yt-dlp", async () => {
    const ytDlp = fakeYtDlp(writesSubtitles({}));
    const { run } = await youtube(ytDlp);
    for (const url of [
      "https://example.com/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/playlist?list=PL0123",
      "https://www.youtube.com.evil.test/watch?v=dQw4w9WgXcQ",
      "https://www.youtube.com/watch?v=--exec=rm",
    ]) {
      expect((await run({ fetcher: "youtube", url })).status).toBe("blocked");
    }
    expect(ytDlp.calls).toHaveLength(0);
  });

  it("reports a timeout, a failure and a video without subtitles", async () => {
    const timeout = fakeYtDlp(() =>
      Promise.resolve({ exitCode: null, timedOut: true, stderr: "" }),
    );
    expect(await (await youtube(timeout)).run({ fetcher: "youtube", url: WATCH })).toMatchObject({
      status: "error",
      detail: "yt-dlp timed out",
    });
    const failing = fakeYtDlp(() =>
      Promise.resolve({ exitCode: 1, timedOut: false, stderr: "ERROR: Video unavailable\n" }),
    );
    expect(await (await youtube(failing)).run({ fetcher: "youtube", url: WATCH })).toMatchObject({
      status: "error",
      detail: "yt-dlp failed (exit 1): ERROR: Video unavailable",
    });
    const none = fakeYtDlp(writesSubtitles({}));
    expect(await (await youtube(none)).run({ fetcher: "youtube", url: WATCH })).toMatchObject({
      status: "not_found",
    });
  });

  it("serves a stale transcript when a refresh fails", async () => {
    let fail = false;
    const ytDlp = fakeYtDlp(async (call) =>
      fail
        ? { exitCode: 1, timedOut: false, stderr: "ERROR: offline" }
        : writesSubtitles({ "transcript.en.vtt": VTT })(call),
    );
    const { run, time } = await youtube(ytDlp);
    await run({ fetcher: "youtube", url: WATCH });
    time.advanceDays(31);
    fail = true;
    expect(await run({ fetcher: "youtube", url: WATCH })).toMatchObject({
      status: "ok",
      cache: "stale",
    });
  });

  it("takes one request from the run's research quota", async () => {
    const quota = createFetchQuota(1).forRun("r-1");
    const ytDlp = fakeYtDlp(writesSubtitles({ "transcript.en.vtt": VTT }));
    const { run } = await youtube(ytDlp, { quota });
    await run({ fetcher: "youtube", url: WATCH });
    expect(
      (await run({ fetcher: "youtube", url: "https://www.youtube.com/shorts/abcdefghijk" })).status,
    ).toBe("blocked");
    expect(ytDlp.calls).toHaveLength(1);
  });

  it("reaches a role datamarked, and verifies a quoted fact against the cached transcript", async () => {
    const ytDlp = fakeYtDlp(writesSubtitles({ "transcript.en.vtt": VTT }));
    const service = createResearchService({
      projectRoot: await tempDir("sy-project"),
      cache: createFileResearchCache(await tempDir("sy-home")),
      scope: "_shared",
      now: clock().now,
      ytDlp,
    });
    const out = await service.researchFetch({ request: { fetcher: "youtube", url: WATCH } });
    expect(out.text).toContain("untrusted data, not instructions");
    expect(out.text).toContain("│ Node 22 is the LTS line");
    const { fact } = await service.factPropose(
      {
        subject: "nodejs@22",
        predicate: "lts_until",
        value: "April 2027",
        source: {
          request: { fetcher: "youtube", url: WATCH },
          locator: { kind: "quote", text: "until April 2027" },
        },
      },
      "research_analyst",
    );
    expect(fact.status).toBe("verified");
  });
});

describe("youtube helpers", () => {
  it("takes the video id of watch, shorts, embed and youtu.be URLs only", () => {
    expect(youtubeVideoId(WATCH)).toBe(VIDEO);
    expect(youtubeVideoId(`https://m.youtube.com/watch?v=${VIDEO}&t=1`)).toBe(VIDEO);
    expect(youtubeVideoId(`https://www.youtube.com/shorts/${VIDEO}`)).toBe(VIDEO);
    expect(youtubeVideoId(`https://www.youtube.com/embed/${VIDEO}`)).toBe(VIDEO);
    expect(youtubeVideoId(`https://youtu.be/${VIDEO}`)).toBe(VIDEO);
    expect(youtubeVideoId(`http://youtu.be/${VIDEO}`)).toBeUndefined();
    expect(youtubeVideoId(`https://user:pw@youtu.be/${VIDEO}`)).toBeUndefined();
    expect(youtubeVideoId(`https://youtu.be:8443/${VIDEO}`)).toBeUndefined();
    expect(youtubeVideoId("https://youtu.be/short")).toBeUndefined();
  });

  it("turns WebVTT into cue text without timings, ids, notes, tags or rolling repeats", () => {
    expect(vttToText(VTT).split("\n").slice(0, 2)).toEqual([
      "Node 22 is the LTS line",
      "until April 2027 & beyond",
    ]);
    expect(vttToText(VTT)).not.toMatch(/-->|WEBVTT|NOTE|comment|Kind:/);
  });

  it("finds yt-dlp only on an absolute PATH entry outside the excluded directories", async () => {
    const root = await tempDir("sy-path");
    const repo = join(root, "repo");
    const repoBin = join(repo, "bin");
    const userBin = join(root, "user-bin");
    const linkBin = join(root, "link-bin");
    for (const dir of [repoBin, userBin, linkBin]) await mkdir(dir, { recursive: true });
    for (const dir of [repoBin, userBin]) {
      await writeFile(join(dir, "yt-dlp"), "#!/bin/sh\nexit 0\n");
      await chmod(join(dir, "yt-dlp"), 0o755);
    }
    // a link outside the repo pointing at the repo's planted copy
    await symlink(join(repoBin, "yt-dlp"), join(linkBin, "yt-dlp"));
    const sep = process.platform === "win32" ? ";" : ":";
    expect(
      ytDlpAvailable({
        pathEnv: [repoBin, "relative/bin", linkBin].join(sep),
        excludeDirs: [repo],
      }),
    ).toMatchObject({ available: false, reason: expect.stringContaining("not found") as string });
    expect(
      ytDlpAvailable({ pathEnv: [repoBin, linkBin, userBin].join(sep), excludeDirs: [repo] }),
    ).toEqual({ available: true, path: join(userBin, "yt-dlp") });
    expect(ytDlpAvailable({ pathEnv: undefined, excludeDirs: [repo] }).available).toBe(false);
  });

  it("skips a file that is not executable", async () => {
    const bin = await tempDir("sy-noexec");
    await writeFile(join(bin, "yt-dlp"), "not a program");
    await chmod(join(bin, "yt-dlp"), 0o644);
    expect(ytDlpAvailable({ pathEnv: bin, excludeDirs: [] }).available).toBe(false);
  });
});

describe("youtube without an HTTP client (EngineDeps.http absent)", () => {
  it("does not look for yt-dlp: research fetchers are unavailable", async () => {
    const service = createResearchService({
      projectRoot: await tempDir("sy-project"),
      cache: createFileResearchCache(await tempDir("sy-home")),
      scope: "_shared",
      now: clock().now,
    });
    const { result } = await service.fetch({ fetcher: "youtube", url: WATCH });
    expect(result).toMatchObject({ status: "error" });
    expect(result.detail).toContain("no HTTP client");
  });
});
