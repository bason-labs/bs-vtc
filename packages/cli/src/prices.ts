/**
 * Prices (H-12; spine §5 reading 236; owner: cli+binary team). A host that reports no cost
 * (Codex) ships a default price table with its adapter (`HostAdapter.defaultPrices`: the
 * provider's public API prices, their page and the day they were read, refreshed each vtc
 * release). `~/.vtc/config.yaml` `prices` may override any model, never has to
 * (`effectivePrices`). The cli hands the engine the result (`EngineDeps.prices`), and `vtc doctor`
 * shows each table's source and date and the user's overrides. A model with no known price never
 * blocks a run (`priceRun`): doctor warns only when such a host has no known price at all, since
 * then the budget cannot count its runs.
 */
import {
  effectivePrices,
  type HostAdapter,
  type HostId,
  type ModelPrice,
  type PriceTable,
} from "@vtc/shared";
import type { DoctorCheck } from "./doctor-checks.js";
import { pricesOf, type UserConfigRead } from "./user-config.js";

/** One host's shipped default price table. */
export interface HostPriceTable {
  readonly host: HostId;
  readonly table: PriceTable;
}

/** The default tables of the adapters that ship one (the hosts that report no cost), by host. */
export const priceTablesOf = (
  adapters: Readonly<Partial<Record<HostId, Pick<HostAdapter, "defaultPrices">>>>,
): HostPriceTable[] =>
  (Object.entries(adapters) as [HostId, Pick<HostAdapter, "defaultPrices"> | undefined][])
    .flatMap(([host, adapter]) =>
      adapter?.defaultPrices === undefined ? [] : [{ host, table: adapter.defaultPrices }],
    )
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));

/**
 * The engine's price table: every shipped table, with the user's prices over them model by model
 * (`effectivePrices`). Only a run whose host reported no cost is priced from it.
 */
export const enginePricesOf = (
  tables: readonly HostPriceTable[],
  user: Readonly<Record<string, ModelPrice>>,
): Readonly<Record<string, ModelPrice>> =>
  // folded from the last table: each table's prices go under everything already merged, so the
  // user's prices end on top of every shipped one
  tables.reduceRight<Readonly<Record<string, ModelPrice>>>(
    (merged, t) => effectivePrices(t.table, merged),
    user,
  );

const NO_COST_NOTE =
  "a model with no price shows cost unknown and the budget counts it at the highest known price";

/**
 * `vtc doctor`'s price lines: one per shipped table (its models, source and date), warning only
 * when the host has no known price at all, then the user's overrides. `read` is `null` when doctor
 * has no user config to read. Nothing when no host ships a table and the user set no prices.
 */
export const checkPrices = (
  read: UserConfigRead | null,
  tables: readonly HostPriceTable[],
): DoctorCheck[] => {
  const user = read === null ? {} : pricesOf(read);
  const checks: DoctorCheck[] = tables.map(({ host, table }) => {
    const models = Object.keys(table.prices).sort();
    if (Object.keys(effectivePrices(table, user)).length === 0)
      return {
        name: "prices",
        status: "warn",
        detail: `${host} reports no cost and no price is known for any model (the table from ${table.source_url} as of ${table.as_of} lists none, and ${read?.path ?? "~/.vtc/config.yaml"} sets none): its runs show cost unknown and budgets cannot count them`,
      };
    return {
      name: "prices",
      status: "ok",
      detail: `${host}: ${String(models.length)} model${models.length === 1 ? "" : "s"} priced (${models.join(", ")}) from ${table.source_url} as of ${table.as_of}, shipped with this vtc; ${NO_COST_NOTE}`,
    };
  });
  if (read === null) return checks;
  if (!read.ok) {
    if (checks.length > 0)
      checks.push({
        name: "prices",
        status: "info",
        detail: `${read.path} does not parse, so none of its prices apply; the shipped tables do (the env line says why)`,
      });
    return checks;
  }
  const overrides = Object.keys(user).sort();
  if (overrides.length > 0) {
    const shippedBy = (model: string): HostId | undefined =>
      tables.find((t) => t.table.prices[model] !== undefined)?.host;
    checks.push({
      name: "prices",
      status: "info",
      detail: `your overrides (prices in ${read.path}): ${overrides
        .map((model) => {
          const host = shippedBy(model);
          return host === undefined ? model : `${model} (replaces the ${host} price)`;
        })
        .join(", ")}`,
    });
  }
  return checks;
};
