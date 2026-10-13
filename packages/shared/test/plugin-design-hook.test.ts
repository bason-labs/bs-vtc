/**
 * Contracts between the compiler, the engine, the adapters, the cli and the dashboard that came
 * from the wave-1 proposals (4.1.0): the plugin manifest, the role-contracts asset, screens.yaml,
 * the `vtc hook` command and the known artifact types.
 */
import { describe, expect, it } from "vitest";
import {
  agentNameFor,
  CONTRACTS_VERSION,
  DESIGN_SCREENS_PATH,
  DesignScreensFileSchema,
  isKnownArtifactType,
  KNOWN_ARTIFACT_TYPES,
  PACK_INPUT_TYPES,
  parsePersisted,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  prototypeStatePath,
  ROLE_CONTRACTS_ASSET,
  sha256Hex,
  VTC_HOOK,
  vtcHookCommand,
  VtcHookInputSchema,
} from "../src/index.js";
import { expectInvalid, expectValid } from "./helpers.js";

const manifest = () => ({
  v: 1,
  host: "claude-code",
  plugin: "vtc",
  contracts_version: CONTRACTS_VERSION,
  agents: [
    {
      name: "vtc-qa-author",
      role: "qa",
      mode: "author",
      kind: "core",
      discipline: null,
      role_version: "1.0.0",
      file: "agents/vtc-qa-author.md",
      prompt_sha256: promptShaFor("You are QA."),
      tier: "mid",
      effort: "medium",
    },
    {
      name: "vtc-engineer-backend",
      role: "engineer_backend",
      mode: null,
      kind: "engineer_profile",
      discipline: "backend",
      role_version: "1.2.0",
      file: "agents/vtc-engineer-backend.md",
      prompt_sha256: promptShaFor("You are a backend engineer."),
      tier: "top",
      effort: "high",
    },
  ],
  skills: [
    {
      name: "stack-nextjs",
      kind: "stack_pack",
      pack: "nextjs",
      file: "skills/stack-nextjs/SKILL.md",
    },
    { name: "vtc", kind: "plugin", pack: null, file: "skills/vtc/SKILL.md" },
  ],
});

describe("PluginManifestSchema (vtc-manifest.json)", () => {
  it("accepts a compiled manifest and names its asset paths", () => {
    expectValid(PluginManifestSchema, manifest());
    expect(PLUGIN_MANIFEST_ASSET).toBe("vtc-manifest.json");
    expect(ROLE_CONTRACTS_ASSET).toBe("vtc/role-contracts.json");
  });
  it("hashes the emitted instructions as the prompt version (§13)", () => {
    expect(promptShaFor("abc")).toBe(sha256Hex("abc"));
    expect(promptShaFor("abc")).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    [
      "agents.0.name",
      (m: ReturnType<typeof manifest>) => ({ ...m, agents: [{ ...m.agents[0], name: "vtc-qa" }] }),
    ],
    [
      "agents.0.prompt_sha256",
      (m: ReturnType<typeof manifest>) => ({
        ...m,
        agents: [{ ...m.agents[0], prompt_sha256: "x" }],
      }),
    ],
    [
      "agents.0.tier",
      (m: ReturnType<typeof manifest>) => ({ ...m, agents: [{ ...m.agents[0], tier: "max" }] }),
    ],
    ["agents", (m: ReturnType<typeof manifest>) => ({ ...m, agents: [m.agents[0], m.agents[0]] })],
    [
      "skills.0.kind",
      (m: ReturnType<typeof manifest>) => ({ ...m, skills: [{ ...m.skills[0], kind: "tool" }] }),
    ],
    ["host", (m: ReturnType<typeof manifest>) => ({ ...m, host: "cursor" })],
  ] as const)("rejects an invalid %s", (path, patch) => {
    expectInvalid(PluginManifestSchema, patch(manifest()), path);
  });
  it("agent names follow agentNameFor", () => {
    for (const agent of manifest().agents) {
      expect(agent.name).toBe(agentNameFor(agent.role, agent.mode ?? undefined));
    }
  });
  it("an older reader drops keys a newer MINOR compiler added", () => {
    const parsed = parsePersisted(PluginManifestSchema, { ...manifest(), built_by: "vtc 9.9" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.stripped.length).toBe(1);
  });
});

describe("DesignScreensFileSchema (screens.yaml, §9)", () => {
  const file = () => ({
    screens: [
      {
        id: "reset-password",
        route: "/reset",
        states: ["empty", "loading", "error", "success"],
        reqs: ["REQ-3", "REQ-3.AC-2"],
      },
      { id: "home", route: "/" },
    ],
  });
  it("accepts screens with routes, states and REQs, and defaults the rest", () => {
    const parsed = expectValid(DesignScreensFileSchema, file());
    expect(parsed.version).toBe(1);
    expect(parsed.screens[1]?.states).toEqual([]);
    expect(DESIGN_SCREENS_PATH).toBe(".vtc/design/screens.yaml");
  });
  it.each([
    ["screens.0.route", { screens: [{ id: "a", route: "reset" }] }],
    ["screens.0.route", { screens: [{ id: "a", route: "/reset?state=x" }] }],
    ["screens.0.states", { screens: [{ id: "a", route: "/", states: ["x", "x"] }] }],
    ["screens.0.reqs.0", { screens: [{ id: "a", route: "/", reqs: ["AC-1"] }] }],
    [
      "screens",
      {
        screens: [
          { id: "a", route: "/" },
          { id: "a", route: "/b" },
        ],
      },
    ],
    ["version", { version: 2, screens: [] }],
  ])("rejects an invalid %s", (path, value) => {
    expectInvalid(DesignScreensFileSchema, value, path);
  });
  it("reaches every state through ?state= and the theme through &theme=", () => {
    expect(prototypeStatePath("/reset", "error", "dark")).toBe("/reset?state=error&theme=dark");
    expect(() => prototypeStatePath("reset", "error", "dark")).toThrow();
    expect(() => prototypeStatePath("/reset", "Error!", "dark")).toThrow();
  });
});

describe("the vtc hook command (AD-8 rule 3)", () => {
  it("wires each host hook to vtc hook <event> --host <host>", () => {
    expect(vtcHookCommand("pre-tool-use", "codex")).toEqual({
      command: "vtc",
      args: ["hook", "pre-tool-use", "--host", "codex"],
    });
    expect(() => vtcHookCommand("post-tool-use" as never, "codex")).toThrow();
    expect(() => vtcHookCommand("session-start", "cursor" as never)).toThrow();
  });
  it("fails open with 0 and blocks only with 2", () => {
    expect(VTC_HOOK.exit).toEqual({ allow: 0, block: 2 });
    expect(VTC_HOOK.timeoutMs).toBeLessThanOrEqual(10_000);
  });
  it("reads the host's hook JSON tolerantly", () => {
    const input = expectValid(VtcHookInputSchema, {
      session_id: "s-1",
      hook_event_name: "PreToolUse",
      agent_type: "vtc:vtc-engineer-backend",
      tool_name: "Bash",
      tool_input: { command: "git push" },
      transcript_path: "/tmp/t.jsonl",
    });
    expect(input.tool_name).toBe("Bash");
    expectValid(VtcHookInputSchema, {});
    expectInvalid(VtcHookInputSchema, { tool_input: "git push" }, "tool_input");
  });
});

describe("KNOWN_ARTIFACT_TYPES", () => {
  it("lists every pack input type once, as slugs", () => {
    for (const type of Object.values(PACK_INPUT_TYPES))
      expect(isKnownArtifactType(type)).toBe(true);
    expect(new Set(KNOWN_ARTIFACT_TYPES).size).toBe(KNOWN_ARTIFACT_TYPES.length);
    for (const type of KNOWN_ARTIFACT_TYPES) expect(type).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    expect(isKnownArtifactType("tasks")).toBe(true);
    expect(isKnownArtifactType("spaceship")).toBe(false);
  });
});
