/**
 * Priced Codex runs (§11; H-12, spine §5 reading 236, replacing reading 152's refusal): Codex
 * reports tokens but no cost, so the engine prices a run's tokens from the host adapter's default
 * price table (`HostAdapter.defaultPrices`) with the user's `~/.vtc/config.yaml` `prices` over it,
 * model by model (`effectivePrices`, `priceRun`). A model with no known price never blocks a run:
 * its cost is unknown (`null`) and the budget counts its tokens at the price ceiling of the host's
 * known prices (`role.submitted.budget_usd`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PriceTableSchema,
  type HostOutcome,
  type LeadAction,
  type PriceTable,
  type RoleResultInput,
} from "@vtc/shared";
import type { CallContext } from "../../src/core/index.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  createHarness,
  spawns,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

// the temp repos and VTC homes go after each test
afterEach(cleanupDirs);

const CODEX: CallContext = { host: "codex" };

interface Line {
  type: string;
  role?: string;
  model?: string;
  cost_usd?: number | null;
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

/** What Codex reports: tokens (cached input apart), no model, no cost. */
const codexDone = (output: Partial<RoleResultInput>): HostOutcome => ({
  kind: "done",
  session_ref: null,
  output: { summary: "done", ...output },
  model: null,
  tokens: { in: 200_000, out: 10_000, cache_r: 100_000, cache_w: 0 },
  cost_usd: null,
});

const cartographer: HeadlessScript = (request) => {
  writeFile(request.cwd, ".vtc/research/repo-map/map.md", "# map\n");
  return codexDone({
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

/** A Codex host as the real adapter is: no `--max-budget-usd`, no reported cost. */
const codexHost = {
  headless: cartographer,
  authStatus: signedIn,
  capabilities: { budgetCap: false },
};

const MODELS = { codex: { top: "gpt-test", mid: "gpt-test", low: "gpt-test" } };
const PRICE = { input_per_mtok: 1, cached_input_per_mtok: 0.1, output_per_mtok: 10 };
const DEAR = { input_per_mtok: 2, cached_input_per_mtok: 0.2, output_per_mtok: 20 };

/** An adapter's default price table (`HostAdapter.defaultPrices`, H-12). */
const table = (prices: Record<string, typeof PRICE>): PriceTable =>
  PriceTableSchema.parse({
    v: 1,
    source_url: "https://example.com/pricing",
    as_of: "2026-10-15",
    prices,
  });

describe(
  "§11, H-12: an engine-launched Codex run is priced from the effective price table",
  { timeout: 30_000 },
  () => {
    it("prices the tokens Codex reported and counts the spend", async () => {
      const h = createHarness({
        project: { hosts: { models: MODELS } },
        codex: codexHost,
        prices: { "gpt-test": PRICE },
      });
      await start(h);
      expect(spawns(await next(h))).toEqual([]);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ host: "codex", ok: true });
      // 200k fresh input × $1 + 100k cached × $0.10 + 10k output × $10, per million tokens
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.model).toBe("gpt-test");
      expect(submitted?.cost_usd).toBe(0.31);
      await h.release();
    });

    it("prices from the adapter's default table when the user set no price (H-12)", async () => {
      const h = createHarness({
        project: { hosts: { models: MODELS } },
        codex: { ...codexHost, defaultPrices: table({ "gpt-test": PRICE }) },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.cost_usd).toBe(0.31);
      // a listed price: the budget counts the cost itself, so no budget_usd
      expect(submitted?.data.budget_usd).toBeUndefined();
      await h.release();
    });

    it("lets the user's price override the default table, model by model (H-12)", async () => {
      const h = createHarness({
        project: { hosts: { models: MODELS } },
        codex: { ...codexHost, defaultPrices: table({ "gpt-test": DEAR }) },
        prices: { "gpt-test": PRICE },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.cost_usd).toBe(0.31);
      await h.release();
    });

    it("an unpriced model never blocks: the run starts, its cost is unknown and the budget counts the price ceiling (H-12)", async () => {
      const h = createHarness({
        project: { hosts: { models: MODELS } },
        codex: {
          ...codexHost,
          defaultPrices: table({ "gpt-cheap": PRICE, "gpt-dear": DEAR }),
        },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ host: "codex", ok: true });
      expect(h.launched).toHaveLength(1);
      expect(h.engine.status({}).run.paused).toBe(false);
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.cost_usd).toBeNull();
      // each token type at its highest known price: 200k × $2 + 100k × $0.20 + 10k × $20
      expect(submitted?.data.budget_usd).toBe(0.62);
      // the run's spend counts what the budget counts
      expect(h.engine.status({}).budget.spent_usd).toBe(0.62);
      await h.release();
    });

    it("a host with no known price at all still runs; its cost and budget stay unknown (H-12)", async () => {
      const h = createHarness({ project: { hosts: { models: MODELS } }, codex: codexHost });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ ok: true });
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.cost_usd).toBeNull();
      expect(submitted?.data.budget_usd).toBeUndefined();
      await h.release();
    });

    it("prices a phase role on the tier it is dispatched on: its own tier clamped by routing.max_tier (D-cm)", async () => {
      // the cartographer's own tier is mid; max_tier low dispatches it on low, which alone is priced
      const h = createHarness({
        project: {
          hosts: { models: { codex: { top: "gpt-top", mid: "gpt-mid", low: "gpt-low" } } },
          routing: { max_tier: "low" },
        },
        codex: codexHost,
        prices: { "gpt-low": PRICE },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ host: "codex", ok: true });
      const dispatched = ofType(h, "role.dispatched").find((e) => e.role === "repo_cartographer");
      expect(dispatched?.model).toBe("gpt-low");
      expect(dispatched?.data).toMatchObject({
        tier: "low",
        tier_reason: "role",
        tier_clamped: true,
      });
      await h.release();
    });

    it("a Codex role on the docs' built-in id (D-co) with no price starts, counted at the ceiling", async () => {
      const h = createHarness({ codex: codexHost, prices: { "gpt-test": PRICE } });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(h.launched).toHaveLength(1);
      // the cartographer's own tier is mid: DEFAULT_TIER_MODELS.codex.mid, which has no price here
      expect(h.launched[0]?.request.model.model).toBe("gpt-6.1-sol");
      const submitted = ofType(h, "role.submitted").find((e) => e.role === "repo_cartographer");
      expect(submitted?.cost_usd).toBeNull();
      expect(submitted?.data.budget_usd).toBe(0.31);
      await h.release();
    });

    it("a host that caps and reports its own spend needs no price", async () => {
      const h = createHarness({
        codex: { headless: cartographer, authStatus: signedIn },
      });
      await start(h);
      await next(h);
      await h.engine.settle();
      expect(ofType(h, "headless.preflight")[0]?.data).toMatchObject({ ok: true });
      // no cost reported and no price: the run is flagged unpriced (null), never $0
      expect(ofType(h, "role.submitted")[0]?.cost_usd).toBeNull();
      await h.release();
    });
  },
);
