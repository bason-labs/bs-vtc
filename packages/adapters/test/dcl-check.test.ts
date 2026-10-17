/**
 * The D-cl live checks' pure parts (scripts/dcl-check-*.ts, spine §5 reading 206) and what their
 * recordings show (codex-cli 0.162.1, 2026-10-15, `test/fixtures/codex/exec-web-search-*`).
 */
import { describe, expect, it } from "vitest";
import { fromStructuredOutput } from "@vtc/shared";
import { parseDclArgs } from "../scripts/dcl-check-args.js";
import {
  armInitFields,
  pluginDebugLines,
  summarizeCodexWebSearch,
  swapWebSearch,
} from "../scripts/dcl-check-lib.js";
import { createCodexAdapter } from "../src/index.js";
import { fixtureLines, fixtureText } from "./support/fixtures.js";

const recorded = (name: string) =>
  fixtureLines(`codex/exec-web-search-${name}.jsonl`).filter((line) => line !== "");

describe("parseDclArgs", () => {
  it("needs a check and an output directory, and defaults the Codex check to cached on the Research Analyst's profile", () => {
    expect(parseDclArgs(["codex-web", "--out", "/tmp/o"])).toEqual({
      target: "codex-web",
      out: "/tmp/o",
      mode: "cached",
      profile: "write_scoped",
    });
    expect(
      parseDclArgs([
        "codex-web",
        "--mode",
        "indexed",
        "--profile",
        "read_only",
        "--open",
        "https://example.com/x",
        "--out",
        "/tmp/o",
      ]),
    ).toMatchObject({ mode: "indexed", profile: "read_only", open: "https://example.com/x" });
    expect(
      parseDclArgs(["claude-arm", "--out", "/tmp/o", "--plugin-dir", "/p", "--model", "haiku"]),
    ).toMatchObject({ target: "claude-arm", pluginDir: "/p", model: "haiku" });
    expect(parseDclArgs(["codex-mcp", "--out", "/tmp/o"])).toMatchObject({ target: "codex-mcp" });
    expect(() => parseDclArgs(["codex-mcp", "--out", "/tmp/o", "--mode", "cached"])).toThrow(
      /not a flag of codex-mcp/u,
    );
  });

  it("refuses a missing check or output, a flag of another check, live web search and an open URL that is not https", () => {
    expect(() => parseDclArgs([])).toThrow(/name a check/u);
    expect(() => parseDclArgs(["codex-web"])).toThrow(/--out/u);
    expect(() => parseDclArgs(["codex-web", "--out", "/o", "--mode", "live"])).toThrow(/--mode/u);
    expect(() => parseDclArgs(["codex-web", "--out", "/o", "--model", "x"])).toThrow(
      /not a flag of codex-web/u,
    );
    expect(() => parseDclArgs(["claude-arm", "--out", "/o", "--mode", "cached"])).toThrow(
      /not a flag/u,
    );
    expect(() => parseDclArgs(["codex-web", "--out", "/o", "--open", "http://x"])).toThrow(
      /https/u,
    );
    expect(() => parseDclArgs(["nope", "--out", "/o"])).toThrow(/the check/u);
    expect(() => parseDclArgs(["codex-web", "--out"])).toThrow(/needs a value/u);
  });
});

describe("swapWebSearch", () => {
  const args = createCodexAdapter({
    vtcHome: "/users-dev/.vtc",
    platform: "darwin",
  }).sandboxProfile({
    tools: { profile: "read_only", write_paths: [], engine_tools: [], host_web: true },
    cwd: "/work/t",
    writablePaths: [],
    protectedPaths: [],
    network: "none",
  }).cliArgs;

  it("changes only the one web_search override, and never to live", () => {
    const swapped = swapWebSearch(args, "cached", "indexed");
    expect(swapped).toContain('web_search="indexed"');
    expect(swapped).not.toContain('web_search="cached"');
    expect(swapped.filter((arg, i) => arg !== args[i])).toEqual(['web_search="indexed"']);
    expect(() => swapWebSearch(args, "cached", "live")).toThrow(/never/u);
    expect(() => swapWebSearch(args, "disabled", "indexed")).toThrow(/exactly one/u);
  });
});

describe("what the Codex web search recordings show (D-cf, D-cl)", () => {
  const adapter = createCodexAdapter({ vtcHome: "/users-dev/.vtc" });
  const parse = (lines: readonly string[]) => adapter.parseEvents(lines);
  const resultOf = (lines: readonly string[]) => {
    const outcome = parse(lines).outcome;
    if (outcome?.kind !== "done") throw new Error("expected done");
    const result = fromStructuredOutput("RoleResult", outcome.output);
    if (!result.success) throw new Error("expected a valid RoleResult");
    return result.data;
  };

  it("cached: a search answered from the index, and no page opened", () => {
    const summary = summarizeCodexWebSearch(recorded("cached"));
    expect(summary.itemTypes).toEqual({ web_search: 1, agent_message: 1 });
    expect(summary.pageActions).toEqual([]);
    expect(resultOf(recorded("cached")).summary).toMatch(/\| https:\/\//u);
  });

  it("cached under read-only: a search, then an open_page of a URL its own results named", () => {
    const lines = recorded("cached-read-only");
    const summary = summarizeCodexWebSearch(lines);
    const search = summary.webSearchItems[0] as { results: { url?: string }[] };
    const named = search.results.map((result) => result.url);
    const opened = summary.pageActions.filter(
      (action): action is { type: "open_page"; url: string } =>
        (action as { type?: unknown }).type === "open_page",
    );
    expect(opened.length).toBeGreaterThan(0);
    for (const action of opened) expect(named).toContain(action.url);
  });

  it("cached handed a model-picked URL: open_page returns only 'Internal Error', which cannot tell no fetch from a failed fetch", () => {
    const lines = recorded("cached-open-refused");
    const summary = summarizeCodexWebSearch(lines);
    expect(summary.pageActions).toHaveLength(1);
    expect(JSON.stringify(summary.pageActions[0])).toMatch(
      /^\{"type":"open_page","url":"https:\/\/example\.com\/vtc-dcl-probe-[0-9a-f]+"\}$/u,
    );
    expect(JSON.stringify(summary.webSearchItems)).toContain('"title":"Internal Error"');
    expect(JSON.stringify(summary.webSearchItems)).not.toContain("Example Domain");
    // the "not accessible via this tool" wording is the role's own summary, not the tool's result
    expect(JSON.stringify(summary.webSearchItems)).not.toContain("not accessible");
    expect(resultOf(lines).summary).toMatch(/could not open/u);
  });

  it("indexed: opens a result page, so it is never a host_web mode", () => {
    const summary = summarizeCodexWebSearch(recorded("indexed"));
    expect(JSON.stringify(summary.pageActions)).toMatch(/"type":"open_page","url":"https:/u);
  });

  it("disabled without the features off: the apps connector still offered a web tool; with them off, none", () => {
    const leaked = recorded("disabled-apps-connector");
    expect(summarizeCodexWebSearch(leaked).itemTypes).toEqual({
      mcp_tool_call: 2,
      agent_message: 1,
    });
    expect(leaked.join("\n")).toContain('"server":"codex_apps","tool":"search_service.web_run"');
    const off = recorded("disabled");
    expect(summarizeCodexWebSearch(off).itemTypes).toEqual({ agent_message: 1 });
    expect(resultOf(off).summary).toBe("no web search available");
  });

  it("every recording parses to a done outcome with nothing unrecognised", () => {
    for (const name of [
      "cached",
      "cached-open-refused",
      "cached-read-only",
      "indexed",
      "disabled",
      "disabled-apps-connector",
    ]) {
      const parsed = parse(recorded(name));
      expect(parsed.outcome?.kind, name).toBe("done");
      expect(parsed.unrecognizedLines, name).toBe(0);
    }
  });
});

describe("the Claude arm recording's helpers", () => {
  it("reads the init record's plugin and agent fields, and the debug lines that name a plugin", () => {
    const init = armInitFields(fixtureLines("claude-code/stream-arm-success.jsonl"));
    expect(init?.plugins).toEqual(
      expect.arrayContaining([
        { name: "vtc", path: "<arm-dir>", source: "vtc@inline", version: "0.1.0" },
      ]),
    );
    expect(init?.agents).toEqual(expect.arrayContaining(["vtc:vtc-qa-judge"]));
    expect(armInitFields(['{"type":"result"}'])).toBeNull();
    const lines = pluginDebugLines(fixtureText("claude-code/arm-debug-plugin-lines.log"));
    expect(lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("--plugin-dir <arm-dir> is one plugin"),
        expect.stringContaining("Loaded inline plugin from path: vtc"),
      ]),
    );
    expect(pluginDebugLines("a\nb plugin c\n")).toEqual(["b plugin c"]);
  });
});

describe("what the offline Codex checks recorded (D-cl, codex-cli 0.162.1, temporary CODEX_HOME)", () => {
  const json = (name: string): unknown => JSON.parse(fixtureText(`codex/${name}`));
  type Read = { web_search: unknown; web_search_request?: unknown; layers?: unknown[] };

  it("precedence: the top-level override wins over the user's and a project's live; the profile layer is compared by marker only; the legacy profile key is refused", () => {
    const p = json("precedence.json") as {
      userLive: Read;
      userLiveWithFlag: Read;
      profileLayerOrder: { profileOnly: string[]; profileAndFlag: string[] };
      legacyProfileKey: { ok: boolean; stderr: string[] };
      untrustedProject: { configReadWithFlag: Read };
      legacySearchKeys: { withFlag: Read };
    };
    expect(p.userLive.web_search).toBe("live");
    expect(p.userLiveWithFlag.web_search).toBe("cached");
    expect(p.untrustedProject.configReadWithFlag.web_search).toBe("cached");
    expect(p.profileLayerOrder).toEqual({
      profileOnly: ["MARK_PROFILE"],
      profileAndFlag: ["MARK_FLAG"],
    });
    expect(p.legacyProfileKey.ok).toBe(false);
    expect(p.legacyProfileKey.stderr.join("\n")).toMatch(/no longer supported/u);
    // the legacy search key stays set beside the override: the adapter refuses it in an override
    expect(p.legacySearchKeys.withFlag).toMatchObject({
      web_search: "disabled",
      web_search_request: true,
    });
  });

  it("plugin add: a local marketplace, then the plugin cached under CODEX_HOME and enabled in config.toml", () => {
    const p = json("plugin-add.json") as {
      results: { argv: string; ok: boolean; stdout: string }[];
      configToml: string;
      codexHomeFiles: string[];
    };
    expect(p.results.every((step) => step.ok)).toBe(true);
    const add = p.results.find((step) => step.argv === "plugin add vtc@vtc-local --json");
    expect(JSON.parse(add?.stdout ?? "{}")).toMatchObject({
      pluginId: "vtc@vtc-local",
      installedPath: "<codex-home>/plugins/cache/vtc-local/vtc/0.1.0",
    });
    expect(p.configToml).toContain("[marketplaces.vtc-local]");
    expect(p.configToml).toContain('[plugins."vtc@vtc-local"]\nenabled = true');
    expect(p.codexHomeFiles).toContain("plugins/cache/vtc-local/vtc/0.1.0/plugin.json");
  });
});
