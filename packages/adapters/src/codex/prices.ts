/**
 * Codex's default price table (H-12; spine §5 reading 236; `HostAdapter.defaultPrices`). Codex
 * reports tokens but no cost, so the engine prices its runs from this table, the user's
 * `~/.vtc/config.yaml` `prices` overriding it model by model (`effectivePrices`).
 *
 * Source: OpenAI's public API pricing page, https://developers.openai.com/api/docs/pricing
 * (where https://platform.openai.com/docs/pricing redirects; https://openai.com/api/pricing/
 * answered 403), read 2026-10-15 as untrusted data. The page carries no "last updated" date.
 * These are its **Standard** tier, **short context** (≤272K input tokens) rows, "Prices per 1M
 * tokens", columns input, cached input, cache writes and output. Not used: the Batch, Flex, Fast
 * (formerly Priority) and Ultrafast tiers, and the long-context rates (>272K input tokens; about
 * twice the input and 1.5 times the output price). A Codex run aggregates its turns' tokens, so a
 * run whose requests went past 272K tokens of context is under-priced by this table.
 *
 * The ids are the ones `DEFAULT_TIER_MODELS.codex` uses (D-co, spine §5 reading 220): top
 * `gpt-6-astra`, mid `gpt-6.1-sol`, low `gpt-6-luna`. A model not listed here is never refused:
 * its cost is unknown and the budget counts it at the table's ceiling (`priceRun`).
 *
 * Refresh it with each VTC release (H-12): read the page again, update the prices and `as_of`.
 */
import type { PriceTable } from "@vtc/shared";

export const CODEX_PRICE_SOURCE_URL = "https://developers.openai.com/api/docs/pricing";

export const CODEX_DEFAULT_PRICES: PriceTable = {
  v: 1,
  source_url: CODEX_PRICE_SOURCE_URL,
  as_of: "2026-10-15",
  prices: {
    "gpt-6-astra": {
      input_per_mtok: 10,
      cached_input_per_mtok: 1,
      cache_write_per_mtok: 12.5,
      output_per_mtok: 50,
    },
    "gpt-6.1-sol": {
      input_per_mtok: 2,
      cached_input_per_mtok: 0.1,
      cache_write_per_mtok: 2.5,
      output_per_mtok: 10,
    },
    "gpt-6-luna": {
      input_per_mtok: 0.1,
      cached_input_per_mtok: 0.01,
      cache_write_per_mtok: 0.125,
      output_per_mtok: 0.5,
    },
  },
};
