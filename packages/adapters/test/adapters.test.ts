import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  findDisallowedHostArgs,
  findForbiddenHostArgs,
  HOST_IDS,
  StatuslineIngestSchema,
  usageFromStatuslineIngest,
} from "@vtc/shared";
import {
  ADAPTER_FACTORIES,
  HOST_CAPABILITIES,
  statuslineIngestFromClaude,
  type AdapterFactoryOptions,
} from "../src/index.js";
import { runHostAdapterSafetyContract } from "./host-adapter-contract.js";

/**
 * Codex host web stays off (spine §7 H-3 row): the D-cl `cached` open probe returned "Internal
 * Error" for a model-picked example.com URL, which cannot tell "no live fetch" from "fetched and
 * failed", and the user's own MCP servers still load into a Codex role run. Flip this only when
 * the §7 row records both as passed.
 */
const CODEX_SAFE_HOST_WEB = false;

const fixture = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${path}`, import.meta.url), "utf8"));

describe("@vtc/adapters smoke", () => {
  it("declares capabilities for every host", () => {
    expect(Object.keys(HOST_CAPABILITIES).sort()).toEqual([...HOST_IDS].sort());
  });
  it("records the Codex gaps the engine must compensate for (§12.1)", () => {
    expect(HOST_CAPABILITIES.codex.perPathWriteDeny).toBe(false);
    expect(HOST_CAPABILITIES.codex.turnCap).toBe(false);
    expect(HOST_CAPABILITIES["claude-code"].perPathWriteDeny).toBe(true);
  });
  it("says whose host web search opens no page the model picks (D-cf, spine §5 reading 200)", () => {
    // Claude: the role profiles deny reading the credential stores, so its web tools are safe
    expect(HOST_CAPABILITIES["claude-code"].safeHostWeb).toBe(true);
    // Codex: not until the §7 H-3 row passes (see CODEX_SAFE_HOST_WEB)
    expect(HOST_CAPABILITIES.codex.safeHostWeb).toBe(CODEX_SAFE_HOST_WEB);
  });
});

/**
 * Trip-wire (AD-6, AD-9): the cli constructs adapters only from ADAPTER_FACTORIES, and every
 * registered adapter runs the safety contract here, so no adapter is wired without passing it.
 * Each factory gets what the cli's engine wiring passes (the extracted plugin and the VTC home).
 */
for (const host of HOST_IDS) {
  const factory = ADAPTER_FACTORIES[host];
  if (factory !== undefined) {
    runHostAdapterSafetyContract(
      factory({
        pluginDir: `/opt/vtc/plugins/${host}`,
        vtcHome: "/home/dev/.vtc",
        vtcVersion: "0.0.0",
      }),
    );
  }
}

describe("adapter registry (AD-6 rule 6)", () => {
  it("registers both hosts, each declaring the capabilities recorded for it", () => {
    expect(Object.keys(ADAPTER_FACTORIES).sort()).toEqual([...HOST_IDS].sort());
    for (const host of HOST_IDS) {
      expect(ADAPTER_FACTORIES[host]?.().capabilities).toEqual(HOST_CAPABILITIES[host]);
    }
  });
  it("every host reports its login through its own status command before unattended runs (AD-25 rule 3)", () => {
    for (const host of HOST_IDS) {
      expect(typeof ADAPTER_FACTORIES[host]?.().authStatus).toBe("function");
    }
  });
  it("only Codex pulls usage itself; Claude usage is pushed (AD-6 rule 4)", () => {
    const codex = ADAPTER_FACTORIES.codex!();
    const claude = ADAPTER_FACTORIES["claude-code"]!();
    expect("readUsage" in codex && "watchUsage" in codex).toBe(true);
    expect("readUsage" in claude || "watchUsage" in claude).toBe(false);
  });
  it("factories take only { pluginDir, vtcHome, vtcVersion }: models come from the engine (AD-6 rule 2, D-ae)", () => {
    const options: AdapterFactoryOptions = {
      pluginDir: "/opt/vtc/plugins/x",
      vtcHome: "/home/dev/.vtc",
      vtcVersion: "1.2.3",
    };
    // @ts-expect-error -- no `models` option: the engine's ResolvedModel is the only source
    const withModels: AdapterFactoryOptions = { models: { codex: { top: "x" } } };
    for (const host of HOST_IDS) {
      const factory: ((options?: AdapterFactoryOptions) => unknown) | undefined =
        ADAPTER_FACTORIES[host];
      expect(factory).toBeDefined();
      expect(ADAPTER_FACTORIES[host]?.(options).host).toBe(host);
    }
    expect(withModels).toBeDefined();
  });
  it("Codex runs the model the engine resolved (AD-6 rule 2)", () => {
    const adapter = ADAPTER_FACTORIES.codex?.();
    const sandbox = adapter!.sandboxProfile({
      tools: { profile: "read_only", write_paths: [], engine_tools: [] },
      cwd: "/w",
      writablePaths: [],
      protectedPaths: [],
      network: "none",
    });
    const args = adapter!.headlessCommand({
      role: "qa",
      model: { tier: "mid", effort: "low", model: "engine-model" },
      dispatch: "headless",
      cwd: "/w",
      prompt: "p",
      outputSchema: {},
      sandbox,
      timeoutMs: 1000,
    }).args;
    expect(args[args.indexOf("--model") + 1]).toBe("engine-model");
  });
});

describe("model ids (AD-6 rule 2)", () => {
  const filesUnder = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  it("no adapter source, script or fixture names a Codex model id: the engine resolves them, and the recommended ids are a §7 spike row", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const files = ["src", "scripts", "test"].flatMap((dir) => filesUnder(join(root, dir)));
    expect(files.length).toBeGreaterThan(20);
    for (const file of files) {
      expect(readFileSync(file, "utf8"), file).not.toMatch(/\bgpt-\d/iu);
    }
  });
});

describe("HostAdapter safety contract (AD-9)", () => {
  it("runs for every registered adapter, and only known hosts can register", () => {
    for (const host of Object.keys(ADAPTER_FACTORIES)) expect(HOST_IDS).toContain(host);
    for (const host of HOST_IDS) {
      const factory = ADAPTER_FACTORIES[host];
      if (factory !== undefined) expect(factory().host).toBe(host);
    }
  });
  it("the bypass detector flags every forbidden form", () => {
    expect(
      findForbiddenHostArgs([
        "--dangerously-skip-permissions",
        "--permission-mode",
        "bypassPermissions",
        "--dangerously-bypass-approvals-and-sandbox",
        "--yolo",
        "--sandbox=danger-full-access",
        "--dangerously-bypass-hook-trust",
        "/Users/me/.claude/.credentials.json",
        "ANTHROPIC_API_KEY=sk-x",
        "--allowedTools",
        "Read",
      ]),
    ).toEqual([
      "--dangerously-skip-permissions",
      "bypassPermissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "--yolo",
      "--sandbox=danger-full-access",
      // Codex's hook-trust bypass is an AD-9 marker since 4.5.0 (AD-25)
      "--dangerously-bypass-hook-trust",
      "/Users/me/.claude/.credentials.json",
      "ANTHROPIC_API_KEY=sk-x",
    ]);
  });
  it("the disallowed-flag detector flags API-key mode and automatic approvers (AD-25 rule 2)", () => {
    expect(
      findDisallowedHostArgs([
        "-p",
        "--bare",
        "--approve-for-me",
        "--not-so-yolo=1",
        "--barely",
        "--permission-mode",
        "dontAsk",
      ]),
    ).toEqual(["--bare", "--approve-for-me", "--not-so-yolo=1"]);
  });
});

describe("Claude statusline ingest (recorded payload)", () => {
  it("extracts only the rate limits, session and model", () => {
    const body = statuslineIngestFromClaude(fixture("claude-code/statusline.json"));
    expect(body).toEqual({
      v: 1,
      session_id: "2b0d5c1e-7f3a-4c6e-9d1a-5e8b2f4a6c90",
      model: "claude-opus-5-5",
      rate_limits: {
        five_hour: { used_percentage: 37.5, resets_at: 1792022400 },
        seven_day: { used_percentage: 12, resets_at: 1792454400 },
      },
    });
    expect(JSON.stringify(body)).not.toContain("/Users/");
    const snapshot = usageFromStatuslineIngest(
      StatuslineIngestSchema.parse(body),
      "2026-10-13T08:00:00Z",
    );
    expect(snapshot.windows.map((w) => [w.kind, w.used_pct])).toEqual([
      ["five_hour", 37.5],
      ["weekly", 12],
    ]);
  });
  it("treats missing or malformed windows as unknown, never 0", () => {
    const body = statuslineIngestFromClaude({
      session_id: "s",
      rate_limits: { five_hour: { used_percentage: "37%", resets_at: 1 } },
    });
    expect(body?.rate_limits).toEqual({ five_hour: null, seven_day: null });
    expect(body?.model).toBeNull();
    expect(statuslineIngestFromClaude("not json")).toBeNull();
    expect(statuslineIngestFromClaude({})?.rate_limits.five_hour).toBeNull();
  });
});
