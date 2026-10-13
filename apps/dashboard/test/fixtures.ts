import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { devArtifact, devArtifactFile } from "../scripts/dev-fixtures.ts";
import { fixtureNameFor, GOLDEN_RUN } from "../scripts/fixture-routes.ts";

const root = `${resolve(import.meta.dirname, "../../../fixtures/golden-run")}/`;

/** One golden-run API response, parsed (the exact response of a read route). */
export const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(`${root}api/${name}.json`, "utf8")) as unknown;

/** A dashboard dev fixture by its `.vtc/` path (`apps/dashboard/dev-fixtures/vtc/`). */
export const readDevFixture = (path: string): string => {
  const file = devArtifactFile(path);
  if (file === null) throw new Error(`no dev fixture for ${path}`);
  return readFileSync(file, "utf8");
};

/** The recorded event log, as the engine writes it. */
export const readEventLog = (): string => readFileSync(`${root}events.jsonl`, "utf8");

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export interface FixtureFetch {
  readonly fetch: typeof fetch;
  readonly requests: { url: string; method: string; headers: Headers; body: string | null }[];
}

/**
 * A `fetch` that answers every read route from the golden-run fixture (404 otherwise), and
 * records each request so tests can check paths and headers.
 */
/** Answers one path instead of the fixture; gets the request (method, body) and its URL. */
export type FixtureOverride = (init: RequestInit | undefined, url: string) => Response;

export const fixtureFetch = (overrides: Record<string, FixtureOverride> = {}): FixtureFetch => {
  const requests: FixtureFetch["requests"] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    requests.push({ url, method, headers: new Headers(init?.headers), body });
    const { pathname, searchParams } = new URL(url, "http://127.0.0.1");
    const override = overrides[pathname];
    if (override) return Promise.resolve(override(init, url));
    const name = fixtureNameFor(method, url);
    if (name === null && method === "GET" && pathname === `/api/runs/${GOLDEN_RUN}/artifacts`) {
      const artifact = devArtifact(GOLDEN_RUN, searchParams.get("path") ?? "");
      if (artifact !== null) return Promise.resolve(json(200, artifact));
    }
    if (name === null || !existsSync(`${root}api/${name}.json`)) {
      return Promise.resolve(json(404, { error: { code: "not_found", message: "no fixture" } }));
    }
    return Promise.resolve(json(200, readFixture(name)));
  };
  return { fetch: impl, requests };
};
