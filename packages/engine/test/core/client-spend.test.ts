/**
 * Cost per client (spec §14; spine §5 reading 153): at `run.finished` the engine appends the run's
 * spend to its client scope's record under the VTC home, and `GET /api/spend` reads the project's
 * scope back, totalled per project. A client never reads another client's record.
 */
import { mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientSpendPath,
  ClientSpendReportSchema,
  ClientSpendRowSchema,
  type ClientSpendRow,
} from "@vtc/shared";
import { createReadModel } from "../../src/core/index.js";
import { readClientSpend, recordClientSpend } from "../../src/core/spend.js";
import { createHttpApi, createSessionStore } from "../../src/http/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  passFinalReview,
  SPEC_ONE,
  throughPlan,
  verdictPass,
  type Harness,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

/** One task through its round and Final Review: the run finishes (Level 1). */
const finishRun = async (h: Harness): Promise<void> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  await verdictPass(
    h,
    only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
    "src/t-1/impl.ts",
  );
  await h.engine.settle();
  await passFinalReview(h);
  await h.engine.settle();
  expect(h.engine.status({}).run.finished_at).toBeDefined();
};

const rowsOf = (home: string, scope: string): ClientSpendRow[] =>
  readFileSync(join(home, `engines/spend/${scope}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => ClientSpendRowSchema.parse(JSON.parse(l)));

const row = (over: Partial<ClientSpendRow>): ClientSpendRow =>
  ClientSpendRowSchema.parse({
    v: 1,
    scope: "client-acme",
    client: "acme",
    repo_key: "a".repeat(16),
    project: "shop",
    run: "r20261013-090000",
    outcome: "done",
    finished_at: "2026-10-13T10:00:00.000Z",
    spent_usd: 1.5,
    unpriced_runs: 0,
    features: [],
    ...over,
  });

describe("cost per client (§14, reading 153)", () => {
  it("records a finished run's spend in its client scope under the VTC home", async () => {
    const h = createHarness({ project: { merge_level: 1, client: "acme" } });
    await finishRun(h);
    expect(clientSpendPath("client-acme")).toBe("engines/spend/client-acme.jsonl");
    const [recorded] = rowsOf(h.home, "client-acme");
    const status = h.engine.status({});
    expect(recorded).toMatchObject({
      scope: "client-acme",
      client: "acme",
      run: status.run.id,
      outcome: "done",
      unpriced_runs: 0,
      features: [{ feature: "F-1" }],
    });
    // every role run of the run, the front half's included, as the run's own spend shows it
    expect(recorded?.spent_usd).toBeCloseTo(status.budget.spent_usd, 4);
    expect(recorded?.spent_usd).toBeGreaterThan(0);
    // the report of the project's scope
    const report = readClientSpend(h.home, "acme");
    expect(report).toMatchObject({ scope: "client-acme", client: "acme", unpriced_runs: 0 });
    expect(report.projects).toEqual([
      expect.objectContaining({ runs: 1, spent_usd: recorded?.spent_usd }),
    ]);
    // another client's scope never sees it
    expect(readClientSpend(h.home, "globex").runs).toEqual([]);
    expect(readClientSpend(h.home, undefined).runs).toEqual([]);
    await h.release();
  });

  it("a project with no client records in the shared scope", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    await finishRun(h);
    expect(rowsOf(h.home, "_shared")).toHaveLength(1);
    expect(readClientSpend(h.home, undefined).client).toBeNull();
    await h.release();
  });

  it("totals per project across runs, counts a run recorded twice once, and skips torn lines", () => {
    const home = tempDir("vtc-home-");
    recordClientSpend(home, row({}));
    recordClientSpend(home, row({ run: "r20261013-100000", spent_usd: 2.25 }));
    recordClientSpend(
      home,
      row({ repo_key: "b".repeat(16), project: "admin", spent_usd: 0.5, unpriced_runs: 2 }),
    );
    // the same run again (a restart finished it twice): the newest row counts
    recordClientSpend(home, row({ spent_usd: 1.75, finished_at: "2026-10-13T11:00:00.000Z" }));
    writeFile(
      home,
      "engines/spend/client-acme.jsonl",
      `${readFileSync(join(home, "engines/spend/client-acme.jsonl"), "utf8")}{"v":1,"torn\n`,
    );
    const report = readClientSpend(home, "acme");
    expect(report.total_usd).toBe(4.5);
    expect(report.unpriced_runs).toBe(2);
    expect(report.projects.map((p) => [p.project, p.runs, p.spent_usd])).toEqual([
      ["shop", 2, 4],
      ["admin", 1, 0.5],
    ]);
    expect(report.runs.map((r) => r.spent_usd)).toEqual([1.75, 2.25, 0.5]);
    expect(ClientSpendReportSchema.parse(report)).toEqual(report);
  });

  it("never reads or writes through a symlink", () => {
    const home = tempDir("vtc-home-");
    const outside = tempDir("vtc-outside-");
    writeFile(outside, "client-acme.jsonl", `${JSON.stringify(row({}))}\n`);
    mkdirSync(join(home, "engines/spend"), { recursive: true });
    symlinkSync(join(outside, "client-acme.jsonl"), join(home, "engines/spend/client-acme.jsonl"));
    expect(readClientSpend(home, "acme").runs).toEqual([]);
    expect(() => {
      recordClientSpend(home, row({}));
    }).toThrow();
  });

  it("is served at GET /api/spend; a dashboard with no record says so", async () => {
    const home = tempDir("vtc-home-");
    recordClientSpend(home, row({}));
    const repo = tempDir("vtc-repo-");
    const serve = async (withRecord: boolean) =>
      createHttpApi({
        readModel: createReadModel({
          repoRoot: repo,
          mode: "live",
          versions: { engine: "0.0.0", contracts: "4.9.0" },
          prototypeUrl: () => null,
          runs: () => [],
          usage: () => new Map(),
          git: null,
          ...(withRecord ? { clientSpend: () => readClientSpend(home, "acme") } : {}),
        }),
        installToken: "i".repeat(43),
        sessions: createSessionStore(() => new Date()),
        assets: { read: () => undefined, list: () => [] },
        repoRoot: repo,
        ingest: null,
        subscribe: null,
        secrets: () => [],
        now: () => new Date(),
      });
    const get = (port: number): Promise<{ status: number; body: string }> =>
      new Promise((resolve, reject) => {
        const req = request(
          {
            host: "127.0.0.1",
            port,
            path: "/api/spend",
            headers: {
              authorization: `Bearer ${"i".repeat(43)}`,
              host: `127.0.0.1:${String(port)}`,
            },
          },
          (res) => {
            let body = "";
            res.on("data", (c: Buffer) => (body += c.toString("utf8")));
            res.on("end", () => {
              resolve({ status: res.statusCode ?? 0, body });
            });
          },
        );
        req.on("error", reject);
        req.end();
      });
    const api = await serve(true);
    const reply = await get(api.port);
    expect(reply.status).toBe(200);
    expect(ClientSpendReportSchema.parse(JSON.parse(reply.body))).toMatchObject({
      scope: "client-acme",
      total_usd: 1.5,
    });
    await api.close();
    const bare = await serve(false);
    expect((await get(bare.port)).status).toBe(404);
    await bare.close();
  });
});
