/**
 * The Codex model id fallback (D-cx; spine §5 reading 244): a run whose model id the host refuses
 * is dispatched once more with no model flag, `role.dispatched.model_fallback` says why, and the
 * refusal lands in `<vtcHome>/engines/model-refusals.jsonl`. The refused attempt is neither a role
 * failure nor a fix round; a second refusal is an ordinary error.
 */
import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_REFUSALS_FILE,
  SESSION_DEFAULT_MODEL,
  type HostOutcome,
  type LeadAction,
  type RoleResultInput,
} from "@vtc/shared";
import type { CallContext } from "../../src/core/index.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import {
  compactRefusals,
  MODEL_REFUSALS_COMPACT_AT,
  readModelRefusals,
  recordModelRefusal,
  refusalDetail,
} from "../../src/core/model-fallback.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  spawns,
  throughPlan,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

const CODEX: CallContext = { host: "codex" };

interface Line {
  type: string;
  role?: string;
  host?: string;
  model?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const ofType = (h: Harness, type: string): Line[] => events(h).filter((e) => e.type === type);

const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CODEX,
  );
const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CODEX)).actions;

const REFUSAL = "The 'gpt-test' model is not supported when using Codex with a ChatGPT account.";

const refused: HostOutcome = {
  kind: "error",
  message: `${REFUSAL}\n(request id 123)`,
  retryable: false,
  cause: "model_refused",
  tokens: null,
  cost_usd: null,
};

const done = (output: Partial<RoleResultInput>): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: null,
  tokens: { in: 1000, out: 100, cache_r: 0, cache_w: 0 },
  cost_usd: null,
});

/** The Cartographer: refused while it asks for a model, done on the host default. */
const cartographer =
  (refuseDefault = false): HeadlessScript =>
  (request) => {
    if (request.model.model !== undefined || refuseDefault) return refused;
    writeFile(request.cwd, ".vtc/research/repo-map/map.md", "# map\n");
    return done({
      role: "repo_cartographer",
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
    });
  };

const signedIn = () =>
  Promise.resolve({
    host: "codex" as const,
    logged_in: true,
    method: "ChatGPT",
    checked_at: "2026-10-13T09:00:00.000Z",
  });

const harness = (script: HeadlessScript): Harness =>
  createHarness({
    project: {
      hosts: { models: { codex: { top: "gpt-test", mid: "gpt-test", low: "gpt-test" } } },
    },
    codex: { headless: script, authStatus: signedIn, capabilities: { budgetCap: false } },
  });

const refusalsFile = (h: Harness): string => join(h.home, MODEL_REFUSALS_FILE);

describe("the model id fallback (D-cx, reading 244)", () => {
  it("retries a refused model once on the host default and logs model_fallback; the refusal is no failure", async () => {
    const h = harness(cartographer());
    await start(h);
    await next(h);
    await h.engine.settle();
    await next(h);
    await h.engine.settle();
    // two launches: the first asked for gpt-test, the retry for no model
    expect(h.launched.map((l) => l.request.model.model)).toEqual(["gpt-test", undefined]);
    const dispatched = ofType(h, "role.dispatched").filter((e) => e.role === "repo_cartographer");
    expect(dispatched).toHaveLength(2);
    expect(dispatched[0]?.model).toBe("gpt-test");
    expect(dispatched[0]?.data.model_fallback).toBeUndefined();
    expect(dispatched[1]?.model).toBe(SESSION_DEFAULT_MODEL);
    expect(dispatched[1]?.data.model_fallback).toEqual({
      requested: "gpt-test",
      reason: "model_refused",
      detail: `${REFUSAL} (request id 123)`,
    });
    // the refused attempt ended as the host said, and is no role failure
    expect(ofType(h, "headless.ended")[0]?.data).toMatchObject({ cause: "model_refused" });
    expect(ofType(h, "role.failed")).toEqual([]);
    expect(ofType(h, "role.submitted").map((e) => e.role)).toEqual(["repo_cartographer"]);
    // the refusal is on file for vtc doctor, private
    const rows = readFileSync(refusalsFile(h), "utf8").trim().split("\n");
    expect(rows.map((r) => JSON.parse(r) as unknown)).toEqual([
      {
        v: 1,
        at: "2026-10-13T09:00:00.000Z",
        host: "codex",
        model: "gpt-test",
        detail: `${REFUSAL} (request id 123)`,
      },
    ]);
    expect(lstatSync(refusalsFile(h)).mode & 0o777).toBe(0o600);
    await h.release();
  });

  it("treats a refusal of the retry as an ordinary error", async () => {
    const h = harness(cartographer(true));
    await start(h);
    await next(h);
    await h.engine.settle();
    await next(h);
    await h.engine.settle();
    expect(h.launched.map((l) => l.request.model.model).slice(0, 2)).toEqual([
      "gpt-test",
      undefined,
    ]);
    const failed = ofType(h, "role.failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.data).toMatchObject({ kind: "error" });
    await h.release();
  });

  it("skips the model flag for an id refused within the last day", async () => {
    const h = harness(cartographer());
    mkdirSync(dirname(refusalsFile(h)), { recursive: true });
    writeFileSync(
      refusalsFile(h),
      `${JSON.stringify({ v: 1, at: "2026-10-13T01:00:00.000Z", host: "codex", model: "gpt-test", detail: "not on your plan" })}\n`,
    );
    await start(h);
    await next(h);
    await h.engine.settle();
    expect(h.launched.map((l) => l.request.model.model)).toEqual([undefined]);
    expect(ofType(h, "role.dispatched")[0]?.data.model_fallback).toEqual({
      requested: "gpt-test",
      reason: "model_refused",
      detail: "not on your plan",
    });
    await h.release();
  });

  it("asks for the model again once the refusal is older than a day", async () => {
    const h = harness(cartographer());
    mkdirSync(dirname(refusalsFile(h)), { recursive: true });
    writeFileSync(
      refusalsFile(h),
      `${JSON.stringify({ v: 1, at: "2026-10-11T09:00:00.000Z", host: "codex", model: "gpt-test" })}\n`,
    );
    await start(h);
    await next(h);
    await h.engine.settle();
    expect(h.launched[0]?.request.model.model).toBe("gpt-test");
    await h.release();
  });

  it("never appends through a symlink in place of the refusals file; the retry still runs", async () => {
    const h = harness(cartographer());
    const outside = join(tempDir("vtc-outside-"), "target.jsonl");
    writeFileSync(outside, "");
    mkdirSync(dirname(refusalsFile(h)), { recursive: true });
    symlinkSync(outside, refusalsFile(h));
    await start(h);
    await next(h);
    await h.engine.settle();
    await next(h);
    await h.engine.settle();
    expect(readFileSync(outside, "utf8")).toBe("");
    expect(h.launched.map((l) => l.request.model.model)).toEqual(["gpt-test", undefined]);
    await h.release();
  });

  it("a refused task role (the cross-family QA judge on Codex) retries on its tier: no failure, no fix round", async () => {
    // refused while it asks for a model; a passing verdict on the host default
    const judge: HeadlessScript = (request) =>
      request.model.model !== undefined
        ? refused
        : {
            kind: "done",
            session_ref: null,
            output: {
              role: "qa",
              mode: "judge",
              task: "T-1",
              summary: "reviewed",
              exit: "done",
              verdicts: [
                {
                  subject: "T-1",
                  verdict: "pass",
                  evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
                },
              ],
            },
            model: null,
            tokens: null,
            cost_usd: 0.1,
          };
    const h = createHarness({
      project: {
        merge_level: 1,
        concurrency: 3,
        hosts: { dispatch: "headless_allowed", cross_family_review: true },
      },
      codex: { headless: judge, authStatus: signedIn },
    });
    const actions = await throughPlan(h, [draft("T-1", { risk: "high" })], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const round = (): number | undefined => h.engine.states().at(-1)?.tasks.get("T-1")?.round;
    const roundBefore = round();
    spawns((await h.engine.next({}, CLAUDE)).actions);
    await h.engine.settle();
    await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    const judges = ofType(h, "role.dispatched").filter(
      (e) => e.role === "qa" && e.host === "codex" && e.data.mode === "judge",
    );
    expect(judges).toHaveLength(2);
    const [first, retry] = judges;
    expect(first?.data.model_fallback).toBeUndefined();
    expect(retry?.data.model_fallback).toMatchObject({
      requested: first?.model,
      reason: "model_refused",
    });
    // the retry is the same step on the same tier, with no model flag
    expect(retry?.data.tier).toBe(first?.data.tier);
    expect(h.launched.map((l) => [l.host, l.request.model.model])).toEqual([
      ["codex", first?.model],
      ["codex", undefined],
    ]);
    // the refused attempt is neither a role failure nor a fix round
    expect(ofType(h, "role.failed")).toEqual([]);
    expect(round()).toBe(roundBefore);
    expect(
      ofType(h, "role.submitted").filter((e) => e.role === "qa" && e.host === "codex"),
    ).toHaveLength(1);
    await h.release();
  });

  it("redacts the host's refusal text before it is kept (AD-18)", () => {
    const secret = "s3cr3t-value-from-dotenv";
    const detail = refusalDetail(`model refused; env VTC_KEY=${secret}\nretry later`, [secret]);
    expect(detail).toBeDefined();
    expect(detail).not.toContain(secret);
    expect(detail).toMatch(/^model refused; env VTC_KEY=.* retry later$/);
  });

  it("compacts the refusals file past its cap: the last day's rows and the latest per host and model stay", () => {
    const home = tempDir("vtc-home-");
    const now = Date.parse("2026-10-13T09:00:00.000Z");
    const old = (i: number) => ({
      v: 1 as const,
      at: new Date(now - 3 * 86_400_000 + i * 1000).toISOString(),
      host: "codex" as const,
      model: `gpt-old-${String(i % 3)}`,
    });
    mkdirSync(dirname(join(home, MODEL_REFUSALS_FILE)), { recursive: true });
    writeFileSync(
      join(home, MODEL_REFUSALS_FILE),
      Array.from(
        { length: MODEL_REFUSALS_COMPACT_AT },
        (_, i) => `${JSON.stringify(old(i))}\n`,
      ).join(""),
    );
    const k = { deps: { vtcHome: home }, now: () => new Date(now) } as unknown as Parameters<
      typeof recordModelRefusal
    >[0];
    recordModelRefusal(k, "codex", "gpt-new", "not on your plan");
    const rows = readModelRefusals(home);
    expect(rows.map((r) => r.model).sort()).toEqual([
      "gpt-new",
      "gpt-old-0",
      "gpt-old-1",
      "gpt-old-2",
    ]);
    expect(rows.at(-1)).toMatchObject({ model: "gpt-new", detail: "not on your plan" });
    expect(rows).toHaveLength(4);
    // the latest row per model is the one kept
    const last = (model: string) =>
      Array.from({ length: MODEL_REFUSALS_COMPACT_AT }, (_, i) => old(i))
        .filter((r) => r.model === model)
        .at(-1);
    expect(rows.find((r) => r.model === "gpt-old-0")).toEqual(last("gpt-old-0"));
    expect(lstatSync(join(home, MODEL_REFUSALS_FILE)).mode & 0o777).toBe(0o600);
    // a recent row is never dropped
    const recent = { ...old(0), at: new Date(now - 1000).toISOString(), model: "gpt-old-1" };
    expect(compactRefusals([recent, old(1)], now)).toEqual([recent, old(1)]);
  });
});
