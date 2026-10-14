/**
 * The research `HttpClient` the cli injects as `EngineDeps.http` (spine AD-22 rule 1): HTTPS only,
 * the private-address guard after DNS on every hop, no cookies, byte and time caps. Fake `fetch`
 * and resolver: no test opens a socket.
 */
import { describe, expect, it } from "vitest";
import type { HttpRequest } from "@vtc/shared";
import {
  bunResolver,
  createHttpClient,
  HttpGuardError,
  MAX_REDIRECTS,
  type Resolve,
} from "../src/http-client.js";

interface Seen {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
  readonly redirect: string | undefined;
}

type Route = (seen: Seen) => Response | Promise<Response>;

const fakeFetch = (routes: Readonly<Record<string, Route>>) => {
  const seen: Seen[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const entry: Seen = {
      url,
      method: init?.method ?? "GET",
      headers: { ...(init?.headers as Record<string, string> | undefined) },
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    };
    seen.push(entry);
    const route = routes[url];
    if (route === undefined) throw new Error(`unexpected fetch ${url}`);
    return route(entry);
  }) as typeof globalThis.fetch;
  return { fetch, seen };
};

const PUBLIC: Resolve = (host) =>
  Promise.resolve(
    (
      {
        "example.com": ["93.184.215.14"],
        "api.example.org": ["2606:4700::6810:84e5", "104.16.132.229"],
        "rebind.example.com": ["93.184.215.14", "10.0.0.7"],
        "internal.example.com": ["192.168.1.20"],
        "metadata.example.com": ["169.254.169.254"],
        "v6local.example.com": ["::1"],
      } as Record<string, string[]>
    )[host] ?? [],
  );

const GET = (url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
  url,
  method: "GET",
  timeoutMs: 5_000,
  maxBytes: 1_000,
  ...extra,
});

const ok = (text: string, headers: Record<string, string> = {}): Response =>
  new Response(text, { status: 200, headers });
const redirect = (status: number, location: string): Response =>
  new Response(null, { status, headers: { location } });

describe("the research HttpClient (AD-22 rule 1)", () => {
  it("fetches over https after a public DNS answer, following no redirect by itself", async () => {
    const { fetch, seen } = fakeFetch({
      "https://example.com/data.json": () => ok('{"a":1}', { "content-type": "application/json" }),
    });
    const res = await createHttpClient({ fetch, resolve: PUBLIC }).request(
      GET("https://example.com/data.json", { headers: { Accept: "application/json" } }),
    );
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('{"a":1}');
    expect(res.headers["content-type"]).toBe("application/json");
    expect(res.url).toBe("https://example.com/data.json");
    expect(seen[0]?.redirect).toBe("manual");
    expect(seen[0]?.headers).toEqual({ accept: "application/json" });
  });

  it.each([
    ["http://example.com/", /only https/],
    ["ftp://example.com/", /only https/],
    ["https://user:pw@example.com/", /user info/],
    ["not a url", /not an absolute URL/],
  ])("refuses %s before resolving or fetching", async (url, message) => {
    const { fetch, seen } = fakeFetch({});
    let resolved = 0;
    const client = createHttpClient({
      fetch,
      resolve: (h) => {
        resolved += 1;
        return PUBLIC(h);
      },
    });
    await expect(client.request(GET(url))).rejects.toThrow(message);
    expect(seen).toEqual([]);
    expect(resolved).toBe(0);
  });

  it.each([
    ["https://internal.example.com/", /private address \(192\.168\.1\.20\)/],
    ["https://metadata.example.com/", /169\.254\.169\.254/],
    ["https://v6local.example.com/", /::1/],
    ["https://rebind.example.com/", /10\.0\.0\.7/],
    ["https://127.0.0.1/", /127\.0\.0\.1/],
    ["https://[::ffff:10.1.2.3]/", /private/],
    ["https://nowhere.example.com/", /does not resolve/],
  ])("refuses %s after DNS (any private address blocks)", async (url, message) => {
    const { fetch, seen } = fakeFetch({});
    const err = await createHttpClient({ fetch, resolve: PUBLIC })
      .request(GET(url))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpGuardError);
    expect(String(err)).toMatch(message);
    expect(seen).toEqual([]);
  });

  it("checks every redirect hop: a redirect to a private host is refused", async () => {
    const { fetch, seen } = fakeFetch({
      "https://example.com/a": () => redirect(302, "https://internal.example.com/secret"),
    });
    await expect(
      createHttpClient({ fetch, resolve: PUBLIC }).request(GET("https://example.com/a")),
    ).rejects.toThrow(/private address/);
    expect(seen.map((s) => s.url)).toEqual(["https://example.com/a"]);
  });

  it("refuses a redirect to plain http", async () => {
    const { fetch } = fakeFetch({
      "https://example.com/a": () => redirect(301, "http://example.com/b"),
    });
    await expect(
      createHttpClient({ fetch, resolve: PUBLIC }).request(GET("https://example.com/a")),
    ).rejects.toThrow(/only https/);
  });

  it("follows public redirects, reports the final URL and stops after the cap", async () => {
    const { fetch } = fakeFetch({
      "https://example.com/a": () => redirect(302, "/b"),
      "https://example.com/b": () => redirect(308, "https://api.example.org/c"),
      "https://api.example.org/c": () => ok("done"),
    });
    const res = await createHttpClient({ fetch, resolve: PUBLIC }).request(
      GET("https://example.com/a"),
    );
    expect(res.url).toBe("https://api.example.org/c");
    expect(new TextDecoder().decode(res.body)).toBe("done");
    const loop = fakeFetch({ "https://example.com/loop": () => redirect(302, "/loop") });
    await expect(
      createHttpClient({ fetch: loop.fetch, resolve: PUBLIC }).request(
        GET("https://example.com/loop"),
      ),
    ).rejects.toThrow(`more than ${String(MAX_REDIRECTS)} redirects`);
    expect(loop.seen).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("keeps a fetcher's key on its own origin and drops it on another", async () => {
    const { fetch, seen } = fakeFetch({
      "https://api.example.org/v1": () => redirect(302, "/v2"),
      "https://api.example.org/v2": () => redirect(302, "https://example.com/elsewhere"),
      "https://example.com/elsewhere": () => ok("x"),
    });
    await createHttpClient({ fetch, resolve: PUBLIC }).request(
      GET("https://api.example.org/v1", {
        headers: { authorization: "Bearer k", "user-agent": "vtc", accept: "*/*" },
      }),
    );
    expect(seen.map((s) => s.headers)).toEqual([
      { authorization: "Bearer k", "user-agent": "vtc", accept: "*/*" },
      { authorization: "Bearer k", "user-agent": "vtc", accept: "*/*" },
      { "user-agent": "vtc", accept: "*/*" },
    ]);
  });

  it("turns a POST into a bodiless GET on 303 and keeps it on 307", async () => {
    const { fetch, seen } = fakeFetch({
      "https://example.com/p": () => redirect(307, "/q"),
      "https://example.com/q": () => redirect(303, "/r"),
      "https://example.com/r": () => ok("r"),
    });
    await createHttpClient({ fetch, resolve: PUBLIC }).request({
      ...GET("https://example.com/p"),
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(seen.map((s) => [s.method, s.body, s.headers["content-type"]])).toEqual([
      ["POST", "{}", "application/json"],
      ["POST", "{}", "application/json"],
      ["GET", undefined, undefined],
    ]);
  });

  it("sends no cookies and returns none", async () => {
    const { fetch, seen } = fakeFetch({
      "https://example.com/": () => ok("x", { "set-cookie": "sid=1", etag: '"e"' }),
    });
    const client = createHttpClient({ fetch, resolve: PUBLIC });
    await expect(
      client.request(GET("https://example.com/", { headers: { Cookie: "sid=1" } })),
    ).rejects.toThrow(/cookies/);
    expect(seen).toEqual([]);
    const res = await client.request(GET("https://example.com/"));
    expect(res.headers).not.toHaveProperty("set-cookie");
    expect(res.headers.etag).toBe('"e"');
  });

  it("caps the body: a declared or a streamed size beyond maxBytes rejects", async () => {
    const big = "x".repeat(2_000);
    const declared = fakeFetch({ "https://example.com/": () => ok(big) });
    await expect(
      createHttpClient({ fetch: declared.fetch, resolve: PUBLIC }).request(
        GET("https://example.com/"),
      ),
    ).rejects.toThrow(/larger than 1000 bytes/);
    const streamed = fakeFetch({
      "https://example.com/": () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (let i = 0; i < 5; i += 1) controller.enqueue(new Uint8Array(300));
              controller.close();
            },
          }),
        ),
    });
    await expect(
      createHttpClient({ fetch: streamed.fetch, resolve: PUBLIC }).request(
        GET("https://example.com/"),
      ),
    ).rejects.toThrow(/larger than 1000 bytes/);
  });

  it("ends at the deadline, aborting the fetch, even when a hop ignores the signal", async () => {
    let aborted = false;
    const hanging = fakeFetch({
      "https://example.com/": () =>
        new Promise<Response>((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("never"));
          }, 10_000).unref();
        }),
    });
    const fetch = ((input: string | URL | Request, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => {
        aborted = true;
      });
      return hanging.fetch(input, init);
    }) as typeof globalThis.fetch;
    const started = Date.now();
    await expect(
      createHttpClient({ fetch, resolve: PUBLIC }).request(
        GET("https://example.com/", { timeoutMs: 50 }),
      ),
    ).rejects.toThrow(/timed out after 50 ms/);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(aborted).toBe(true);
    const slowDns: Resolve = () => new Promise(() => undefined);
    await expect(
      createHttpClient({ fetch, resolve: slowDns }).request(
        GET("https://example.com/", { timeoutMs: 50 }),
      ),
    ).rejects.toThrow(/timed out/);
  });

  it("uses Bun's resolver only where Bun provides one", () => {
    expect(bunResolver()).toBeNull();
  });
});
