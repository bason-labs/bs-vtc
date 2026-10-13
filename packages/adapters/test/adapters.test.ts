import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  findForbiddenHostArgs,
  HOST_IDS,
  StatuslineIngestSchema,
  usageFromStatuslineIngest,
} from "@vtc/shared";
import { ADAPTER_FACTORIES, HOST_CAPABILITIES, statuslineIngestFromClaude } from "../src/index.js";
import { runHostAdapterSafetyContract } from "./host-adapter-contract.js";

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
});

/**
 * Trip-wire (AD-6, AD-9): the cli constructs adapters only from ADAPTER_FACTORIES, and every
 * registered adapter runs the safety contract here, so no adapter is wired without passing it.
 */
for (const host of HOST_IDS) {
  const factory = ADAPTER_FACTORIES[host];
  if (factory !== undefined) runHostAdapterSafetyContract(factory());
}

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
      "/Users/me/.claude/.credentials.json",
      "ANTHROPIC_API_KEY=sk-x",
    ]);
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
