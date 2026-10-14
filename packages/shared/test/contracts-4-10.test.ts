/**
 * Contracts 4.10.0 (the wave-3 closing round; spine §5 readings 156–176): host web search (H-3),
 * API-key billing (D-bq), finish at Level 2 (D-bd), the G2 direction count (D-bt), the engineer
 * profile's locked identity (D-br), and the helpers moved here so two teams enforce one rule
 * (editable sections, tiebreak keys).
 */
import { describe, expect, it } from "vitest";
import {
  API_KEY_BILLING_WARNING,
  CONTRACTS_VERSION,
  DesignCoverageReportSchema,
  editableSectionErrors,
  engineerProfileLockedSection,
  EscalationOptionSchema,
  FactProposeInputSchema,
  FactRowSchema,
  G2_DIRECTIONS,
  HostAuthStatusSchema,
  lookbackTiebreakKey,
  RESERVED_EDITABLE_HEADINGS,
  RoleToolsSchema,
  sha256Hex,
  TASK_PACK_HEURISTICS_SECTION,
  TASK_PACK_SECTIONS,
  UsageSnapshotSchema,
  UserConfigSchema,
  type Attribution,
} from "../src/index.js";

const SHA = "a".repeat(64);
const NOW = "2026-10-14T08:00:00.000Z";

describe("contracts 4.10.0", () => {
  it("is MINOR over 4.9.0 (and still in force: 4.11.0 is MINOR too)", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("4");
    expect(Number(CONTRACTS_VERSION.split(".")[1])).toBeGreaterThanOrEqual(10);
  });
});

describe("host web search (H-3, reading 156)", () => {
  it("is a per-role opt-in, never for a role that runs code", () => {
    expect(RoleToolsSchema.parse({ profile: "read_only" }).host_web).toBeUndefined();
    expect(
      RoleToolsSchema.parse({
        profile: "write_scoped",
        write_paths: [".vtc/research/briefs/**"],
        host_web: true,
      }).host_web,
    ).toBe(true);
    expect(
      RoleToolsSchema.safeParse({
        profile: "code_sandboxed",
        write_paths: ["src/**"],
        host_web: true,
      }).success,
    ).toBe(false);
  });

  it("records where a host result came from without verifying it", () => {
    const row = {
      v: 1,
      id: "f-0123456789abcdef",
      subject: "npm:react@19.2.0",
      predicate: "license",
      value: "MIT",
      status: "unverified",
      source: null,
      reported_source: {
        url: "https://example.org/react",
        via: "host_search",
        query: "react licence",
      },
      recorded_by: "research_analyst",
      recorded_at: NOW,
    };
    expect(FactRowSchema.parse(row).reported_source?.via).toBe("host_search");
    // provenance is not a source: a verified row still needs the engine's own fetch
    expect(FactRowSchema.safeParse({ ...row, status: "verified" }).success).toBe(false);
    expect(
      FactRowSchema.safeParse({ ...row, reported_source: { url: "https://x.org", via: "memory" } })
        .success,
    ).toBe(false);
    expect(
      FactProposeInputSchema.parse({
        subject: "npm:react@19.2.0",
        predicate: "license",
        value: "MIT",
        source: {
          request: { fetcher: "web", url: "https://example.org/react" },
          locator: { kind: "quote", text: "MIT" },
        },
        reported_source: { url: "https://example.org/react", via: "host_fetch" },
      }).reported_source,
    ).toEqual({ url: "https://example.org/react", via: "host_fetch" });
  });

  it("the keyed search provider has no default", () => {
    const config = UserConfigSchema.parse({ version: 1, research: {} });
    expect(config.research?.search_provider).toBeUndefined();
    expect(
      UserConfigSchema.parse({
        version: 1,
        research: { search_provider: "exa", api_keys: { search: "EXA_KEY" } },
      }).research?.search_provider,
    ).toBe("exa");
    expect(
      UserConfigSchema.safeParse({ version: 1, research: { search_provider: "google" } }).success,
    ).toBe(false);
  });
});

describe("API-key billing (D-bq, reading 171)", () => {
  it("is carried on the sign-in check and the usage snapshot, and is optional", () => {
    const status = { host: "codex", logged_in: true, method: "API key", checked_at: NOW };
    expect(HostAuthStatusSchema.parse(status).billing).toBeUndefined();
    expect(HostAuthStatusSchema.parse({ ...status, billing: "api_key" }).billing).toBe("api_key");
    expect(HostAuthStatusSchema.safeParse({ ...status, billing: "free" }).success).toBe(false);
    const snapshot = { host: "codex", source: "app_server", updated_at: null };
    expect(UsageSnapshotSchema.parse(snapshot).billing).toBeUndefined();
    expect(UsageSnapshotSchema.parse({ ...snapshot, billing: null }).billing).toBeNull();
    expect(API_KEY_BILLING_WARNING).toMatch(/^API-key billing: /);
  });
});

describe("finish at Level 2 (D-bd, reading 158)", () => {
  it("is an answer effect", () => {
    expect(
      EscalationOptionSchema.parse({
        id: "finish-l2",
        label: "Finish at Level 2: leave the PR for review",
        effect: "finish_level_2",
      }).effect,
    ).toBe("finish_level_2");
  });
});

describe("G2 direction count (D-bt, reading 174)", () => {
  const clean = {
    reqs_without_component: [],
    reqs_without_screen: [],
    screens_without_req: [],
    components_unregistered: [],
  };
  it("is 2–3, and a directions problem fails the DESIGN check", () => {
    expect(G2_DIRECTIONS).toEqual({ min: 2, max: 3 });
    expect(DesignCoverageReportSchema.safeParse({ ...clean, ok: true }).success).toBe(true);
    const problem = { ...clean, directions_problem: "1 direction; 2 required" };
    expect(DesignCoverageReportSchema.safeParse({ ...problem, ok: false }).success).toBe(true);
    expect(DesignCoverageReportSchema.safeParse({ ...problem, ok: true }).success).toBe(false);
  });
});

describe("engineer profile locked identity (D-br, reading 172)", () => {
  it("is the Engineer's whole prompt, then the profile's locked core", () => {
    const text = engineerProfileLockedSection(
      { locked: "  E locked\n", editable: "\nE editable  " },
      "\nP locked\n",
    );
    expect(text).toBe("E locked\n\nE editable\n\nP locked");
    expect(
      engineerProfileLockedSection({ locked: "E locked", editable: "E editable v2" }, "P locked"),
    ).not.toBe(text);
  });
});

describe("editable-section rules (moved from @vtc/compiler, reading 175)", () => {
  it("reserves every task-pack heading and the heuristics heading", () => {
    expect(RESERVED_EDITABLE_HEADINGS).toEqual([
      ...TASK_PACK_SECTIONS,
      TASK_PACK_HEURISTICS_SECTION,
    ]);
  });
  it("refuses a mode block, a placeholder and a reserved heading, line by line", () => {
    expect(editableSectionErrors("- Prefer small diffs.\n### Tips\n- Cite evidence.")).toEqual([]);
    const errors = editableSectionErrors(
      [
        "<!-- vtc:mode plan -->",
        "Use {{stack}} idioms.",
        "## Role heuristics",
        "### dispatch ###",
      ].join("\n"),
    );
    expect(errors).toHaveLength(4);
    expect(errors[0]).toMatch(/^editable section line 1: no mode block/);
    expect(errors[1]).toMatch(/^editable section line 2: no placeholder \(\{\{stack\}\}\)/);
    expect(errors[2]).toBe(
      'editable section line 3: heading "Role heuristics" is reserved for the task pack',
    );
    expect(errors[3]).toBe(
      'editable section line 4: heading "dispatch" is reserved for the task pack',
    );
  });
});

describe("tiebreak key (moved from the lookback module, reading 175)", () => {
  const row: Attribution = {
    v: 1,
    trace: "a-3",
    run: "R-1",
    prompt: {
      role: "engineer",
      host: "claude-code",
      locked_sha256: SHA,
      editable_sha256: SHA,
      effective_sha256: SHA,
    },
    outcome: "failure",
    blamed_role: "engineer",
    method: "ai_tiebreak",
    confidence: 0.7,
    split: "train",
    evidence: [{ type: "file", ref: "src/a.ts" }],
    attributed_at: NOW,
  };

  it("is the frozen digest, blind to the split and the time", () => {
    expect(lookbackTiebreakKey(row)).toBe(
      sha256Hex(
        JSON.stringify([
          "R-1",
          "a-3",
          "engineer",
          null,
          "claude-code",
          SHA,
          "engineer",
          0.7,
          [["file", "src/a.ts"]],
        ]),
      ),
    );
    expect(lookbackTiebreakKey({ ...row, split: "holdout", attributed_at: SHA })).toBe(
      lookbackTiebreakKey(row),
    );
    expect(lookbackTiebreakKey({ ...row, blamed_role: "qa" })).not.toBe(lookbackTiebreakKey(row));
  });
});
