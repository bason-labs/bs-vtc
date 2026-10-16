import { describe, expect, it } from "vitest";
import {
  effectivePrices,
  priceCeiling,
  priceRun,
  PriceTableSchema,
  type ModelPrice,
} from "@vtc/shared";
import { CODEX_DEFAULT_PRICES } from "../../src/codex/prices.js";
import { createClaudeCodeAdapter, createCodexAdapter } from "../../src/index.js";

/**
 * The Codex ids the engine's built-in tier map uses (`DEFAULT_TIER_MODELS.codex`, D-co, spine §5
 * reading 220). The adapter cannot import the engine (AD-1), so they are named here; if the
 * engine's map changes, this list and the price table change with it.
 */
const CODEX_TIER_MODEL_IDS = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"] as const;

describe("Codex default price table (H-12, spine §5 reading 236)", () => {
  it("is a valid PriceTable from OpenAI's public pricing page, with its URL and as-of date", () => {
    const table = PriceTableSchema.parse(CODEX_DEFAULT_PRICES);
    expect(table.source_url).toMatch(/^https:\/\/developers\.openai\.com\//u);
    expect(table.as_of).toBe("2026-10-15");
  });

  it("prices every model the built-in Codex tiers use", () => {
    for (const id of CODEX_TIER_MODEL_IDS) {
      expect(CODEX_DEFAULT_PRICES.prices[id], id).toBeDefined();
    }
  });

  it("carries the Standard short-context list prices read from the page (USD per MTok)", () => {
    const price = (input: number, cached: number, write: number, output: number): ModelPrice => ({
      input_per_mtok: input,
      cached_input_per_mtok: cached,
      cache_write_per_mtok: write,
      output_per_mtok: output,
    });
    expect(CODEX_DEFAULT_PRICES.prices).toEqual({
      "gpt-6-astra": price(10, 1, 12.5, 50),
      "gpt-6.1-sol": price(2, 0.1, 2.5, 10),
      "gpt-6-luna": price(0.1, 0.01, 0.125, 0.5),
    });
  });

  it("prices a recorded-size Codex run and counts an unpriced model at the ceiling", () => {
    const prices = effectivePrices(CODEX_DEFAULT_PRICES, undefined);
    const tokens = { in: 23_903, out: 1_000, cache_r: 23_552, cache_w: 0 };
    const sol = priceRun(tokens, "gpt-6.1-sol", prices);
    expect(sol).toEqual({ cost_usd: 0.0602, budget_usd: 0.0602, basis: "listed" });
    const unknown = priceRun(tokens, "gpt-7-unlisted", prices);
    expect(unknown.cost_usd).toBeNull();
    expect(unknown.basis).toBe("ceiling");
    expect(priceCeiling(Object.values(prices))).toEqual(CODEX_DEFAULT_PRICES.prices["gpt-6-astra"]);
  });

  it("is what the Codex adapter ships; Claude Code reports its own cost and ships none", () => {
    expect(createCodexAdapter().defaultPrices).toBe(CODEX_DEFAULT_PRICES);
    expect(createClaudeCodeAdapter().defaultPrices).toBeUndefined();
  });
});
