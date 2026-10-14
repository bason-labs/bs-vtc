import {
  FactRowSchema,
  RESEARCH_FACTS_FILE,
  researchScopeFor,
  validateEventData,
  type FactProposeInput,
} from "@vtc/shared";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFileResearchCache,
  createResearchService,
  SEARCH_NOT_A_SOURCE,
  type ResearchEventDraft,
} from "../../src/research/index.js";
import { clock, FixtureHttp, jsonResponse, respond, tempDir } from "./fixture-http.js";
import { guardNoNetwork } from "./no-network.js";

guardNoNetwork();

const NPM_URL = "https://registry.npmjs.org/react/19.2.0";
const DEPS_URL = "https://api.deps.dev/v3/systems/npm/packages/react/versions/19.2.0";
const PAGE = "https://react.dev/versions";
const ROBOTS = "https://react.dev/robots.txt";

const setup = async (
  routes: ConstructorParameters<typeof FixtureHttp>[0] = {},
  client?: string,
  home?: string,
) => {
  const http = new FixtureHttp(routes);
  const vtcHome = home ?? (await tempDir("home"));
  const projectRoot = await tempDir("project");
  const time = clock();
  const events: ResearchEventDraft[] = [];
  const service = createResearchService({
    projectRoot,
    cache: createFileResearchCache(vtcHome),
    scope: researchScopeFor(client),
    http,
    now: time.now,
    onEvent: (event) => {
      events.push(event);
    },
  });
  const factsOnDisk = async () =>
    (await readFile(join(projectRoot, RESEARCH_FACTS_FILE), "utf8"))
      .trim()
      .split("\n")
      .map((line) => FactRowSchema.parse(JSON.parse(line)));
  return { http, vtcHome, projectRoot, time, events, service, factsOnDisk };
};

const licenceFact = (
  value: string,
  request: FactProposeInput["source"] = null,
): FactProposeInput => ({
  subject: "npm:react@19.2.0",
  predicate: "license",
  value,
  source: request,
});

const fromNpm = {
  request: { fetcher: "registry", registry: "npm", name: "react", version: "19.2.0" },
  locator: { kind: "json_pointer", pointer: "/license" },
} as const;
const fromDeps = {
  request: { fetcher: "depsdev", system: "npm", name: "react", version: "19.2.0" },
  locator: { kind: "json_pointer", pointer: "/licenses/0" },
} as const;

describe("research_fetch", () => {
  it("returns the result and datamarked text, and emits research.fetched", async () => {
    const { service, events } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    const out = await service.researchFetch({ request: fromNpm.request });
    expect(out.result).toMatchObject({ status: "ok", cache: "miss" });
    expect(out.text).toContain('│   "license": "MIT"');
    expect(events.map((e) => e.type)).toEqual(["research.fetched"]);
    for (const e of events) expect(validateEventData(e.type, e.data).ok).toBe(true);
  });

  it("rejects input that is not a ResearchFetchInput", async () => {
    const { service } = await setup();
    await expect(
      service.researchFetch({ request: { fetcher: "web", url: "http://x.test/" } }),
    ).rejects.toThrow();
  });
});

describe("fact_propose (AD-22 rule 3)", () => {
  it("records a verified fact when the JSON Pointer resolves to the value", async () => {
    const { service, events, factsOnDisk } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    const { fact } = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    expect(fact).toMatchObject({
      status: "verified",
      recorded_by: "architect",
      source: {
        fetcher: "registry",
        url: NPM_URL,
        locator: { kind: "json_pointer", pointer: "/license" },
      },
      expires_at: "2026-10-15T10:00:00.000Z",
    });
    expect(await factsOnDisk()).toEqual([fact]);
    expect(events.map((e) => e.type)).toEqual(["research.fetched", "fact.recorded"]);
    for (const e of events) expect(validateEventData(e.type, e.data).ok).toBe(true);
  });

  it("keeps a claim unverified when the source says something else or has no source", async () => {
    const { service, http } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    expect(
      (await service.factPropose(licenceFact("Apache-2.0", fromNpm), "architect")).fact.status,
    ).toBe("unverified");
    const before = http.requests.length;
    const { fact } = await service.factPropose(licenceFact("MIT"), "research_analyst");
    expect(fact).toMatchObject({ status: "unverified", source: null });
    expect(http.requests.length).toBe(before);
  });

  it("verifies a verbatim quote against the page's markdown", async () => {
    const { service } = await setup({
      [`GET ${ROBOTS}`]: respond(ROBOTS, 404, ""),
      [`GET ${PAGE}`]: respond(PAGE, 200, "<main><p>React 19.2 is the latest version.</p></main>", {
        "content-type": "text/html",
      }),
    });
    const { fact } = await service.factPropose(
      {
        subject: "react",
        predicate: "latest_version",
        value: "19.2",
        source: {
          request: { fetcher: "web", url: PAGE },
          locator: { kind: "quote", text: "React 19.2 is the latest version." },
        },
      },
      "research_analyst",
    );
    expect(fact.status).toBe("verified");
  });

  it("does not record the same verified claim twice", async () => {
    const { service, factsOnDisk } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    expect(await factsOnDisk()).toHaveLength(1);
  });

  it("marks both facts conflicting when two sources disagree", async () => {
    const { service, factsOnDisk } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
      [`GET ${DEPS_URL}`]: jsonResponse(DEPS_URL, { licenses: ["Apache-2.0"] }),
    });
    const first = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    const second = await service.factPropose(licenceFact("Apache-2.0", fromDeps), "architect");
    expect(second.fact.status).toBe("conflicting");
    const rows = await factsOnDisk();
    expect(rows.at(-1)).toMatchObject({
      id: first.fact.id,
      status: "conflicting",
      recorded_by: "engine",
    });
    const lookup = await service.factLookup({ subject: "npm:react@19.2.0", predicate: "license" });
    expect(lookup.facts.map((f) => f.status)).toEqual(["conflicting", "conflicting"]);
  });

  it("supersedes the old claim when the same source now says something else", async () => {
    const { service, time, http } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    const old = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    http.set(`GET ${NPM_URL}`, jsonResponse(NPM_URL, { license: "ISC" }));
    time.advanceDays(2);
    const next = await service.factPropose(licenceFact("ISC", fromNpm), "architect");
    expect(next.fact).toMatchObject({ status: "verified", supersedes: old.fact.id });
    const lookup = await service.factLookup({ subject: "npm:react@19.2.0" });
    expect(lookup.facts.map((f) => f.value)).toEqual(["ISC"]);
    // By id, the superseded row is still there to read.
    expect((await service.factLookup({ ids: [old.fact.id] })).facts[0]?.value).toBe("MIT");
  });

  it("records a fact from a source served stale as stale", async () => {
    const { service, time, http } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    await service.fetch(fromNpm.request);
    http.set(`GET ${NPM_URL}`, new Error("offline"));
    time.advanceDays(3);
    expect((await service.factPropose(licenceFact("MIT", fromNpm), "architect")).fact.status).toBe(
      "stale",
    );
  });
});

describe("without an HTTP client (EngineDeps.http absent)", () => {
  it("answers from the cache only, and new facts stay unverified", async () => {
    const projectRoot = await tempDir("project");
    const service = createResearchService({
      projectRoot,
      cache: createFileResearchCache(await tempDir("home")),
      scope: "_shared",
      now: clock().now,
    });
    const { result } = await service.fetch(fromNpm.request);
    expect(result).toMatchObject({
      status: "error",
      detail: "no HTTP client: research fetchers are unavailable",
    });
    const { fact } = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    expect(fact).toMatchObject({ status: "unverified", source: null });
  });
});

describe("scope isolation (§14)", () => {
  it("never serves one client's cache to another", async () => {
    const home = await tempDir("home");
    const acme = await setup(
      { [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }) },
      "acme",
      home,
    );
    await acme.service.fetch(fromNpm.request);
    expect((await acme.service.fetch(fromNpm.request)).result.cache).toBe("hit");
    const globex = await setup(
      { [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }) },
      "globex",
      home,
    );
    expect((await globex.service.fetch(fromNpm.request)).result.cache).toBe("miss");
    expect(globex.http.requests).toHaveLength(1);
  });
});

describe("G2 fact list (AD-22 rule 4)", () => {
  it("lists unverified, stale and conflicting facts plus document claims, never verified ones", async () => {
    const { service } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
      [`GET ${DEPS_URL}`]: jsonResponse(DEPS_URL, { licenses: ["MIT"] }),
    });
    const verified = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    const unsourced = await service.factPropose(
      { subject: "nodejs@18", predicate: "eol_date", value: "2025-04-30", source: null },
      "architect",
    );
    const g2 = await service.g2Facts([
      {
        path: ".vtc/spec/architecture.md",
        text: `Use react (${verified.fact.id}).\nUNVERIFIED: Bun 1.4 supports node:sqlite`,
      },
    ]);
    expect(g2.facts.map((f) => [f.status, f.predicate, f.reason])).toEqual([
      ["unverified", "eol_date", "no source"],
      ["unverified", "unverified_claim", "an UNVERIFIED: tag at .vtc/spec/architecture.md:2"],
    ]);
    expect(g2.unverified_facts).toEqual([unsourced.fact.id, g2.facts[1]?.id]);
  });

  it("re-fetches an expired fact before G2: a 304 keeps it verified", async () => {
    const { service, time, http, events } = await setup({
      [`GET ${NPM_URL}`]: [
        jsonResponse(NPM_URL, { license: "MIT" }, { etag: '"r1"' }),
        respond(NPM_URL, 304, "", { etag: '"r1"' }),
      ],
    });
    const { fact } = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    time.advanceDays(2);
    const g2 = await service.g2Facts([]);
    expect(g2.facts).toEqual([]);
    expect(http.requests.at(-1)?.headers?.["if-none-match"]).toBe('"r1"');
    const verifiedEvent = events.find((e) => e.type === "fact.verified");
    expect(verifiedEvent?.data).toMatchObject({ id: fact.id, status: "verified" });
    const [row] = (await service.factLookup({ ids: [fact.id] })).facts;
    expect(row?.expires_at).toBe("2026-10-17T10:00:00.000Z");
  });

  it("lists a fact whose source changed so the locator no longer resolves", async () => {
    const { service, time, http } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    http.set(`GET ${NPM_URL}`, jsonResponse(NPM_URL, { license: "ISC" }));
    time.advanceDays(2);
    const g2 = await service.g2Facts([]);
    expect(g2.facts).toMatchObject([
      { status: "unverified", reason: "the source has another value", source_url: NPM_URL },
    ]);
  });

  it("lists an expired fact that cannot be re-fetched as stale", async () => {
    const { service, time, http } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    http.set(`GET ${NPM_URL}`, new Error("offline"));
    time.advanceDays(2);
    expect((await service.g2Facts([])).facts.map((f) => f.status)).toEqual(["stale"]);
  });

  it("records each waiver as fact.waived with its reason, for that one G2", async () => {
    const { service, events, projectRoot } = await setup();
    const { fact } = await service.factPropose(licenceFact("MIT"), "architect");
    const g2 = await service.g2Facts([{ path: "a.md", text: "UNVERIFIED: something" }]);
    const before = await readFile(join(projectRoot, RESEARCH_FACTS_FILE), "utf8");
    const waived = await service.recordWaivers(
      g2.unverified_facts.map((id) => ({ id, reason: "accepted risk for the prototype" })),
    );
    expect(waived.map((w) => w.id)).toEqual([fact.id, g2.facts[1]?.id]);
    const drafts = events.filter((e) => e.type === "fact.waived");
    expect(drafts.map((e) => e.data)).toEqual([
      { id: fact.id, reason: "accepted risk for the prototype" },
      { id: g2.facts[1]?.id, reason: "accepted risk for the prototype" },
    ]);
    for (const e of drafts) expect(validateEventData(e.type, e.data).ok).toBe(true);
    // Nothing is persisted: the next G2 asks again.
    expect(await readFile(join(projectRoot, RESEARCH_FACTS_FILE), "utf8")).toBe(before);
    expect((await service.g2Facts([])).unverified_facts).toEqual([fact.id]);
  });

  it("lists a claim that cites a made-up fact id", async () => {
    const { service } = await setup();
    const g2 = await service.g2Facts([
      { path: "research.md", text: "lodash@4.17.21 is fine (f-0123456789abcdef)" },
    ]);
    expect(g2.facts).toMatchObject([
      {
        predicate: "uncited_claim",
        status: "unverified",
        reason:
          "a version, licence, CVE or EOL claim that cites unknown fact f-0123456789abcdef at research.md:1",
      },
    ]);
  });

  it("does not list a claim that cites a current verified fact", async () => {
    const { service } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    const { fact } = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    const g2 = await service.g2Facts([
      { path: "research.md", text: `react@19.2.0 is MIT licensed (${fact.id})` },
    ]);
    expect(g2.facts).toEqual([]);
  });

  it("re-checks rows recorded verified: a planted row or a missing blob is listed", async () => {
    const { service, projectRoot } = await setup();
    const planted = FactRowSchema.parse({
      v: 1,
      id: "f-00000000000000ab",
      subject: "npm:left-pad@1.3.0",
      predicate: "license",
      value: "MIT",
      status: "verified",
      source: {
        fetcher: "registry",
        url: "https://registry.npmjs.org/left-pad/1.3.0",
        retrieved_at: "2026-10-14T09:00:00.000Z",
        content_sha256: "c".repeat(64),
        locator: { kind: "json_pointer", pointer: "/license" },
      },
      expires_at: "2026-10-20T00:00:00.000Z",
      recorded_by: "engine",
      recorded_at: "2026-10-14T09:00:00.000Z",
    });
    await mkdir(join(projectRoot, ".vtc/research"), { recursive: true });
    await appendFile(join(projectRoot, RESEARCH_FACTS_FILE), `${JSON.stringify(planted)}\n`);
    const g2 = await service.g2Facts([]);
    expect(g2.facts).toMatchObject([
      {
        id: planted.id,
        status: "unverified",
        reason:
          "recorded verified but does not verify against the cache: the cited source is not in this machine's cache",
      },
    ]);
  });

  it("re-checks a recorded verified row against its blob: a value the blob lacks is listed", async () => {
    const { service, projectRoot, factsOnDisk } = await setup({
      [`GET ${NPM_URL}`]: jsonResponse(NPM_URL, { license: "MIT" }),
    });
    const { fact } = await service.factPropose(licenceFact("MIT", fromNpm), "architect");
    const forged = { ...fact, id: "f-00000000000000cd", value: "Apache-2.0" };
    await appendFile(join(projectRoot, RESEARCH_FACTS_FILE), `${JSON.stringify(forged)}\n`);
    expect(await factsOnDisk()).toHaveLength(2);
    const g2 = await service.g2Facts([]);
    expect(g2.facts).toMatchObject([
      {
        id: forged.id,
        reason:
          "recorded verified but does not verify against the cache: the source has another value",
      },
    ]);
  });
});

describe("search results are not fact sources (spec §10)", () => {
  it("keeps a fact sourced from the search fetcher unverified", async () => {
    const SEARCH = "https://api.tavily.com/search";
    const http = new FixtureHttp({
      [`POST ${SEARCH}`]: jsonResponse(SEARCH, { results: [{ content: "react is MIT" }] }),
    });
    const service = createResearchService({
      projectRoot: await tempDir("project"),
      cache: createFileResearchCache(await tempDir("home")),
      scope: "_shared",
      http,
      now: clock().now,
      apiKey: (name) => (name === "search" ? "tvly-test-key-0000" : undefined),
    });
    const { fact } = await service.factPropose(
      {
        subject: "react",
        predicate: "license",
        value: "react is MIT",
        source: {
          request: { fetcher: "search", query: "react licence" },
          locator: { kind: "json_pointer", pointer: "/results/0/content" },
        },
      },
      "research_analyst",
    );
    expect(fact.status).toBe("unverified");
    const g2 = await service.g2Facts([]);
    expect(g2.facts).toMatchObject([{ id: fact.id, reason: SEARCH_NOT_A_SOURCE }]);
  });
});
