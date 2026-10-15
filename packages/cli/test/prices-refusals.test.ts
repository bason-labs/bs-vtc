/**
 * H-12 (spine §5 reading 236): the engine prices a run with no host-reported cost from each
 * adapter's shipped default table, the user's `~/.vtc/config.yaml` `prices` overriding model by
 * model; `vtc doctor` shows each table's source and date and the overrides, and warns only when a
 * host that reports no cost has no known price at all. D-cx (reading 244): `vtc doctor` reports
 * the model ids a host refused, from `<vtcHome>/engines/model-refusals.jsonl`.
 */
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MODEL_REFUSALS_FILE,
  USER_CONFIG_FILE,
  type HostAdapter,
  type HostId,
  type PriceTable,
} from "@vtc/shared";
import { createDoctorCommand, type DoctorCommandEnv } from "../src/commands/doctor.js";
import type { Exec } from "../src/process.js";
import { checkModelRefusals, readModelRefusals } from "../src/model-refusals.js";
import { checkPrices, enginePricesOf, priceTablesOf } from "../src/prices.js";
import { pricesOf, readUserConfig } from "../src/user-config.js";
import { buildEngineParts } from "../src/wiring.js";
import { createDiskAssetBundle } from "../src/assets.js";
import { capture, cleanupDirs, fakePullRequests, initRepo, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const SOL = {
  input_per_mtok: 1.25,
  cached_input_per_mtok: 0.125,
  output_per_mtok: 10,
  cache_write_per_mtok: 0,
};
const LUNA = {
  input_per_mtok: 0.25,
  cached_input_per_mtok: 0.025,
  output_per_mtok: 2,
  cache_write_per_mtok: 0,
};
const MINE = {
  input_per_mtok: 1,
  cached_input_per_mtok: 0.1,
  output_per_mtok: 8,
  cache_write_per_mtok: 0,
};

const CODEX_TABLE: PriceTable = {
  v: 1,
  source_url: "https://openai.com/api/pricing/",
  as_of: "2026-10-01",
  prices: { "gpt-6.1-sol": SOL, "gpt-6-luna": LUNA },
};

const adapter = (host: HostId, defaultPrices?: PriceTable): HostAdapter =>
  ({
    host,
    dispose: () => Promise.resolve(),
    ...(defaultPrices === undefined ? {} : { defaultPrices }),
  }) as unknown as HostAdapter;

const writeUserConfig = (home: string, yaml: string): void => {
  writeFileSync(join(home, USER_CONFIG_FILE), yaml);
};

const OVERRIDE_SOL =
  "version: 1\nprices:\n  gpt-6.1-sol:\n    input_per_mtok: 1\n    cached_input_per_mtok: 0.1\n    output_per_mtok: 8\n  gpt-mine:\n    input_per_mtok: 1\n    cached_input_per_mtok: 0.1\n    output_per_mtok: 8\n";

describe("the engine's prices: each adapter's default table, the user's prices over it (H-12)", () => {
  it("lists only the adapters that ship a table, by host", () => {
    expect(
      priceTablesOf({
        codex: adapter("codex", CODEX_TABLE),
        "claude-code": adapter("claude-code"),
      }),
    ).toEqual([{ host: "codex", table: CODEX_TABLE }]);
    expect(priceTablesOf({ "claude-code": adapter("claude-code") })).toEqual([]);
  });

  it("overlays the user's prices model by model", () => {
    const tables = [{ host: "codex" as const, table: CODEX_TABLE }];
    expect(enginePricesOf(tables, {})).toEqual({ "gpt-6.1-sol": SOL, "gpt-6-luna": LUNA });
    expect(enginePricesOf(tables, { "gpt-6.1-sol": MINE, "gpt-mine": MINE })).toEqual({
      "gpt-6.1-sol": MINE,
      "gpt-6-luna": LUNA,
      "gpt-mine": MINE,
    });
    expect(enginePricesOf([], { "gpt-mine": MINE })).toEqual({ "gpt-mine": MINE });
    expect(enginePricesOf([], {})).toEqual({});
  });

  const parts = async (home: string, codex: PriceTable | undefined) =>
    buildEngineParts({
      automation: null,
      createArmPluginCompiler: null,
      repoRoot: initRepo(),
      vtcHome: home,
      installToken: "t".repeat(64),
      assets: createDiskAssetBundle({}),
      pullRequests: fakePullRequests(),
      openStorage: () => {
        throw new Error("not opened in this test");
      },
      http: null,
      adapterFactories: {
        codex: () => adapter("codex", codex),
        "claude-code": () => adapter("claude-code"),
      },
    });

  it("wires the shipped table into the daemon with no user config at all", async () => {
    const built = await parts(tempHome(), CODEX_TABLE);
    expect(built.prices).toEqual({ "gpt-6.1-sol": SOL, "gpt-6-luna": LUNA });
  });

  it("lets ~/.vtc/config.yaml override a model, and ignores a file that does not parse", async () => {
    const home = tempHome();
    writeUserConfig(home, OVERRIDE_SOL);
    expect((await parts(home, CODEX_TABLE)).prices).toEqual({
      "gpt-6.1-sol": MINE,
      "gpt-6-luna": LUNA,
      "gpt-mine": MINE,
    });
    // a broken file overrides nothing: the shipped table still prices every run it lists
    writeUserConfig(home, "version: 1\nprices:\n  gpt-6.1-sol: free\n");
    expect(pricesOf(readUserConfig(home))).toEqual({});
    expect((await parts(home, CODEX_TABLE)).prices).toEqual({
      "gpt-6.1-sol": SOL,
      "gpt-6-luna": LUNA,
    });
  });

  it("passes no prices when no adapter ships a table and the user set none", async () => {
    expect((await parts(tempHome(), undefined)).prices).toBeUndefined();
  });
});

describe("vtc doctor: price tables and overrides (H-12)", () => {
  const tables = [{ host: "codex" as const, table: CODEX_TABLE }];

  it("shows each table's source and date, and never asks the user to fill a table", () => {
    const checks = checkPrices(readUserConfig(tempHome()), tables);
    expect(checks).toEqual([
      {
        name: "prices",
        status: "ok",
        detail:
          "codex: 2 models priced (gpt-6-luna, gpt-6.1-sol) from https://openai.com/api/pricing/ as of 2026-10-01, shipped with this vtc; a model with no price shows cost unknown and the budget counts it at the highest known price",
      },
    ]);
    expect(JSON.stringify(checks)).not.toMatch(/no model is priced|empty/);
  });

  it("lists the user's overrides, naming which replace a shipped price", () => {
    const home = tempHome();
    writeUserConfig(home, OVERRIDE_SOL);
    const checks = checkPrices(readUserConfig(home), tables);
    expect(checks).toHaveLength(2);
    expect(checks[1]).toEqual({
      name: "prices",
      status: "info",
      detail: `your overrides (prices in ${join(home, USER_CONFIG_FILE)}): gpt-6.1-sol (replaces the codex price), gpt-mine`,
    });
  });

  it("says a config that does not parse overrides nothing (the env line says why)", () => {
    const home = tempHome();
    writeUserConfig(home, "version: [\n");
    const checks = checkPrices(readUserConfig(home), tables);
    expect(checks.map((c) => c.status)).toEqual(["ok", "info"]);
    expect(checks[1]?.detail).toMatch(/does not parse, so none of its prices apply/);
  });

  it("warns only when a host that reports no cost has no known price at all", () => {
    const empty: PriceTable = { ...CODEX_TABLE, prices: {} };
    const home = tempHome();
    const [warn] = checkPrices(readUserConfig(home), [{ host: "codex", table: empty }]);
    expect(warn).toEqual({
      name: "prices",
      status: "warn",
      detail: `codex reports no cost and no price is known for any model (the table from https://openai.com/api/pricing/ as of 2026-10-01 lists none, and ${join(home, USER_CONFIG_FILE)} sets none): its runs show cost unknown and budgets cannot count them`,
    });
    // a user price is a known price: no warning
    writeUserConfig(home, OVERRIDE_SOL);
    expect(
      checkPrices(readUserConfig(home), [{ host: "codex", table: empty }]).map((c) => c.status),
    ).toEqual(["ok", "info"]);
  });

  it("reports nothing when every host reports its own cost and the user set no prices", () => {
    expect(checkPrices(readUserConfig(tempHome()), [])).toEqual([]);
    expect(checkPrices(null, [])).toEqual([]);
  });
});

const refusalsPath = (home: string): string => join(home, MODEL_REFUSALS_FILE);

const writeRefusals = (home: string, lines: readonly string[]): void => {
  mkdirSync(dirname(refusalsPath(home)), { recursive: true });
  writeFileSync(refusalsPath(home), lines.join("\n") + "\n", { mode: 0o600 });
};

const row = (at: string, model: string, detail?: string, host = "codex"): string =>
  JSON.stringify({ v: 1, at, host, model, ...(detail === undefined ? {} : { detail }) });

describe("vtc doctor: the model ids a host refused (D-cx)", () => {
  it("reads nothing when the engine never recorded a refusal", () => {
    const read = readModelRefusals(tempHome());
    expect(read).toEqual({ kind: "none" });
    expect(checkModelRefusals(read)).toEqual([]);
  });

  it("reports each (host, model) once with its last time and detail, skipping lines that do not parse", () => {
    const home = tempHome();
    writeRefusals(home, [
      row("2026-10-14T08:00:00Z", "gpt-6-astra", "model not available on your plan"),
      "not json",
      JSON.stringify({ v: 1, at: "yesterday", host: "codex", model: "x" }),
      row("2026-10-15T09:30:00Z", "gpt-6-astra", "The 'gpt-6-astra' model is not supported"),
      row("2026-10-13T07:00:00Z", "gpt-6-luna"),
      "",
    ]);
    const read = readModelRefusals(home);
    expect(read).toEqual({
      kind: "read",
      path: refusalsPath(home),
      skipped: 2,
      refused: [
        {
          host: "codex",
          model: "gpt-6-astra",
          last: "2026-10-15T09:30:00Z",
          times: 2,
          detail: "The 'gpt-6-astra' model is not supported",
        },
        { host: "codex", model: "gpt-6-luna", last: "2026-10-13T07:00:00Z", times: 1 },
      ],
    });
    const checks = checkModelRefusals(read);
    expect(checks).toEqual([
      {
        name: "model ids",
        status: "info",
        detail:
          "codex refused gpt-6-astra (2 times, last 2026-10-15T09:30:00Z: The 'gpt-6-astra' model is not supported); its runs fall back to the host default. To choose another id, set hosts.models.codex in .vtc/project.yaml",
      },
      {
        name: "model ids",
        status: "info",
        detail:
          "codex refused gpt-6-luna (1 time, last 2026-10-13T07:00:00Z); its runs fall back to the host default. To choose another id, set hosts.models.codex in .vtc/project.yaml",
      },
      {
        name: "model ids",
        status: "info",
        detail: `2 line(s) of ${refusalsPath(home)} do not parse and were skipped`,
      },
    ]);
  });

  it("escapes control characters in the host's detail", () => {
    const home = tempHome();
    writeRefusals(home, [row("2026-10-15T09:30:00Z", "gpt-6-astra", "bad\u001b[2Jmodel")]);
    const [check] = checkModelRefusals(readModelRefusals(home));
    expect(check?.detail).toContain("bad\\u001b[2Jmodel");
  });

  it("does not follow a link in place of the file", () => {
    const home = tempHome();
    const elsewhere = tempHome();
    writeRefusals(elsewhere, [row("2026-10-15T09:30:00Z", "gpt-6-astra")]);
    mkdirSync(dirname(refusalsPath(home)), { recursive: true });
    symlinkSync(refusalsPath(elsewhere), refusalsPath(home));
    const read = readModelRefusals(home);
    expect(read).toEqual({ kind: "unreadable", path: refusalsPath(home) });
    expect(checkModelRefusals(read)).toEqual([
      {
        name: "model ids",
        status: "warn",
        detail: `${refusalsPath(home)} is not a regular file, so the refused model ids are not shown`,
      },
    ]);
  });
});

describe("vtc doctor prints the price and refusal lines", () => {
  const quiet: Exec = () => Promise.resolve({ code: 0, stdout: "", stderr: "" });

  const doctor = async (home: string, env: Partial<DoctorCommandEnv>) => {
    const { ctx, out } = capture("/w", home);
    const code = await createDoctorCommand(() => ({
      exec: quiet,
      versions: { node: "22.17.1" },
      userConfig: () => readUserConfig(home),
      ...env,
    })).run([], ctx);
    return { code, text: out.join("\n") };
  };

  it("shows the shipped table and the refused ids, and fails neither", async () => {
    const home = tempHome();
    writeRefusals(home, [row("2026-10-15T09:30:00Z", "gpt-6-astra", "not available")]);
    const { code, text } = await doctor(home, {
      priceTables: () => Promise.resolve([{ host: "codex", table: CODEX_TABLE }]),
      modelRefusals: () => readModelRefusals(home),
    });
    expect(code).toBe(0);
    expect(text).toMatch(/^ok {4}prices {7}codex: 2 models priced .* as of 2026-10-01/m);
    expect(text).toMatch(/^info {2}model ids {4}codex refused gpt-6-astra \(1 time/m);
    expect(text).not.toMatch(/no model is priced/);
  });
});
