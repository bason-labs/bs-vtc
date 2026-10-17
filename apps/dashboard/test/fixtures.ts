import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  apiFixtureFile,
  artifactContent,
  devArtifact,
  devArtifactFile,
} from "../scripts/dev-fixtures.ts";
import { fixtureNameFor, GOLDEN_RUN } from "../scripts/fixture-routes.ts";
import { SAMPLE_REPLAY_TEXT, SAMPLE_RUN, samplePage } from "./golden-samples";

const root = `${resolve(import.meta.dirname, "../../../fixtures/golden-run")}/`;

/** One golden-run API response, parsed (the exact response of a read route). */
export const readFixture = (name: string): unknown => {
  const file = apiFixtureFile(`${root}api`, name);
  if (file === null) throw new Error(`no fixture ${name}`);
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
};

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

/** Answers one path instead of the fixture; gets the request (method, body) and its URL. */
export type FixtureOverride = (init: RequestInit | undefined, url: string) => Response;

/** The replay result the golden wave-3 samples' `lookback.replay_finished` names. */
const SAMPLE_REPLAY_PATH = ".vtc/lookback/replays/p-engineer-1.json";

/**
 * A `fetch` that answers every read route from the golden-run fixture (404 otherwise), and
 * records each request so tests can check paths and headers. The golden wave-3 samples' run
 * (`golden-wave3`) answers its event log, its replay result and the dashboard's dev artifacts.
 */
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
    if (method === "GET" && pathname === `/api/runs/${SAMPLE_RUN}/events`) {
      return Promise.resolve(json(200, samplePage()));
    }
    if (method === "GET" && pathname === `/api/runs/${SAMPLE_RUN}/artifacts`) {
      const path = searchParams.get("path") ?? "";
      const artifact =
        path === SAMPLE_REPLAY_PATH
          ? artifactContent(SAMPLE_RUN, path, SAMPLE_REPLAY_TEXT)
          : devArtifact(SAMPLE_RUN, path);
      return Promise.resolve(
        artifact === null
          ? json(404, { error: { code: "not_found", message: "no fixture" } })
          : json(200, artifact),
      );
    }
    const name = fixtureNameFor(method, url);
    if (name === null && method === "GET" && pathname === `/api/runs/${GOLDEN_RUN}/artifacts`) {
      const artifact = devArtifact(GOLDEN_RUN, searchParams.get("path") ?? "");
      if (artifact !== null) return Promise.resolve(json(200, artifact));
    }
    if (name === null || apiFixtureFile(`${root}api`, name) === null) {
      return Promise.resolve(json(404, { error: { code: "not_found", message: "no fixture" } }));
    }
    return Promise.resolve(json(200, readFixture(name)));
  };
  return { fetch: impl, requests };
};
