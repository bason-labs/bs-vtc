import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fixtureNameFor } from "../scripts/fixture-routes.ts";

const root = `${resolve(import.meta.dirname, "../../../fixtures/golden-run")}/`;

/** One golden-run API response, parsed (the exact response of a read route). */
export const readFixture = (name: string): unknown =>
  JSON.parse(readFileSync(`${root}api/${name}.json`, "utf8")) as unknown;

/** The recorded event log, as the engine writes it. */
export const readEventLog = (): string => readFileSync(`${root}events.jsonl`, "utf8");

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export interface FixtureFetch {
  readonly fetch: typeof fetch;
  readonly requests: { url: string; method: string; headers: Headers }[];
}

/**
 * A `fetch` that answers every read route from the golden-run fixture (404 otherwise), and
 * records each request so tests can check paths and headers.
 */
export const fixtureFetch = (overrides: Record<string, () => Response> = {}): FixtureFetch => {
  const requests: FixtureFetch["requests"] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    requests.push({ url, method, headers: new Headers(init?.headers) });
    const path = new URL(url, "http://127.0.0.1").pathname;
    const override = overrides[path];
    if (override) return Promise.resolve(override());
    const name = fixtureNameFor(method, url);
    if (name === null || !existsSync(`${root}api/${name}.json`)) {
      return Promise.resolve(json(404, { error: { code: "not_found", message: "no fixture" } }));
    }
    return Promise.resolve(json(200, readFixture(name)));
  };
  return { fetch: impl, requests };
};
