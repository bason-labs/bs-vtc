/**
 * The wave-3 closing round in the compile step (spine §5 readings 156, 166, 167, 172, 175):
 * - the editable-section rules come from `@vtc/shared` (reading 175);
 * - the Spec Verifier is switched to the pack (D-bl, reading 166);
 * - an engineer profile's identity covers the Engineer prompt it carries (D-br, reading 172);
 * - a `host_web` role gets its host's web tools (H-3, reading 156).
 * Fixture-level: the mechanisms. The repo's own sources: `closing-repo.test.ts`.
 */
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import * as shared from "@vtc/shared";
import {
  engineerProfileLockedSection,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  PROMPT_MARKERS,
  sha256Hex,
  splitRolePrompt,
  type HostId,
  type PluginManifest,
} from "@vtc/shared";
import {
  compilePlugins,
  EDITABLE_IN_PACK_ROLES,
  editableSectionErrors,
  renderTemplate,
  RESERVED_EDITABLE_HEADINGS,
  rolePromptAssetPath,
  type CompileOutput,
} from "../src/index.js";
import { FIXTURE, fixtureFiles } from "./fixtures.js";

const HOSTS: readonly HostId[] = ["claude-code", "codex"];

const compileOk = (overrides: Record<string, string | null> = {}): CompileOutput => {
  const result = compilePlugins(fixtureFiles(overrides));
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  return result.output;
};

const fileOf = (output: CompileOutput, host: HostId, path: string): string => {
  const found = output.targets[host].find((f) => f.path === path);
  if (found === undefined) throw new Error(`${host} target has no ${path}`);
  return found.text;
};

const manifest = (output: CompileOutput, host: HostId): PluginManifest =>
  PluginManifestSchema.parse(JSON.parse(fileOf(output, host, PLUGIN_MANIFEST_ASSET)));

const agentOf = (output: CompileOutput, host: HostId, name: string) => {
  const agent = manifest(output, host).agents.find((a) => a.name === name);
  if (agent === undefined) throw new Error(`no agent ${name}`);
  return agent;
};

const sectionsOf = (text: string): { locked: string; editable: string } => {
  const split = splitRolePrompt(text);
  if (!split.ok) throw new Error(split.errors.join("\n"));
  return { locked: split.locked, editable: split.editable };
};

const prompt = (locked: string, editable: string): string =>
  `${PROMPT_MARKERS.locked}\n${locked}\n${PROMPT_MARKERS.editable}\n${editable}\n`;

describe("the editable-section rules are @vtc/shared's (reading 175)", () => {
  it("re-exports the shared helper and headings, not a copy", () => {
    expect(editableSectionErrors).toBe(shared.editableSectionErrors);
    expect(RESERVED_EDITABLE_HEADINGS).toBe(shared.RESERVED_EDITABLE_HEADINGS);
  });

  it("refuses an editable section with a reserved heading, with the shared message", () => {
    const result = compilePlugins(
      fixtureFiles({ "roles/qa/prompt.md": prompt("QA-SHARED", "## Dispatch\nQA-EDITABLE") }),
    );
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.errors.map((e) => e.message);
    expect(messages).toContain(
      `prompt.md: ${shared.editableSectionErrors("## Dispatch\nQA-EDITABLE")[0] ?? ""}`,
    );
  });
});

describe("the Spec Verifier is switched to the pack (D-bl, reading 166)", () => {
  it("is the only role in EDITABLE_IN_PACK_ROLES", () => {
    expect(EDITABLE_IN_PACK_ROLES).toEqual(["spec_verifier"]);
  });
});

describe("an engineer profile's identity covers the Engineer prompt (D-br, reading 172)", () => {
  const output = compileOk();
  const engineer = sectionsOf(FIXTURE["roles/engineer/prompt.md"] ?? "");
  const profile = sectionsOf(FIXTURE["roles/engineer_frontend/prompt.md"] ?? "");
  const expectedLocked = engineerProfileLockedSection(engineer, profile.locked);

  it.each(HOSTS)(
    "on %s the profile's locked_sha256 hashes engineerProfileLockedSection",
    (host) => {
      const agent = agentOf(output, host, "vtc-engineer-frontend");
      expect(agent.locked_sha256).toBe(sha256Hex(expectedLocked.trim()));
      expect(agent.editable_sha256).toBe(sha256Hex(profile.editable.trim()));
    },
  );

  it.each(HOSTS)("on %s the profile's locked asset carries the same text", (host) => {
    const locked = fileOf(output, host, rolePromptAssetPath("vtc-engineer-frontend", "locked"));
    expect(locked).toBe(expectedLocked);
    expect(sha256Hex(locked.trim())).toBe(
      agentOf(output, host, "vtc-engineer-frontend").locked_sha256,
    );
    expect(fileOf(output, host, rolePromptAssetPath("vtc-engineer-frontend", "editable"))).toBe(
      profile.editable,
    );
  });

  it("leaves every other agent's identity at its own sections", () => {
    const agent = agentOf(output, "claude-code", "vtc-engineer");
    expect(agent.locked_sha256).toBe(sha256Hex(engineer.locked.trim()));
    expect(fileOf(output, "claude-code", rolePromptAssetPath("vtc-engineer", "locked"))).toBe(
      engineer.locked,
    );
  });

  it.each([
    ["locked core", prompt("ENGINEER-LOCKED-2", "ENGINEER-EDITABLE")],
    ["editable section", prompt("ENGINEER-LOCKED", "ENGINEER-EDITABLE-2")],
  ])("changing the Engineer's %s changes every profile's locked_sha256", (_part, changed) => {
    const after = compileOk({
      "roles/engineer/prompt.md": changed,
      // a second profile, so "every profile" is more than one
      "roles/engineer_backend/role.yaml": (FIXTURE["roles/engineer_frontend/role.yaml"] ?? "")
        .replace("id: engineer_frontend", "id: engineer_backend")
        .replace("discipline: frontend", "discipline: backend"),
      "roles/engineer_backend/prompt.md": prompt("BACKEND-LOCKED", "BACKEND-EDITABLE"),
    });
    const before = compileOk({
      "roles/engineer_backend/role.yaml": (FIXTURE["roles/engineer_frontend/role.yaml"] ?? "")
        .replace("id: engineer_frontend", "id: engineer_backend")
        .replace("discipline: frontend", "discipline: backend"),
      "roles/engineer_backend/prompt.md": prompt("BACKEND-LOCKED", "BACKEND-EDITABLE"),
    });
    for (const host of HOSTS) {
      const profiles = manifest(after, host).agents.filter((a) => a.kind === "engineer_profile");
      expect(profiles.map((a) => a.name).sort()).toEqual([
        "vtc-engineer-backend",
        "vtc-engineer-frontend",
      ]);
      for (const agent of profiles) {
        const was = agentOf(before, host, agent.name);
        expect(agent.locked_sha256, agent.name).not.toBe(was.locked_sha256);
        // the profile's own section, and so its proposals, are untouched
        expect(agent.editable_sha256, agent.name).toBe(was.editable_sha256);
      }
      // a non-profile role keeps its identity
      expect(agentOf(after, host, "vtc-qa-judge").locked_sha256).toBe(
        agentOf(before, host, "vtc-qa-judge").locked_sha256,
      );
    }
  });
});

describe("host web tools for a host_web role (H-3, reading 156)", () => {
  const RESEARCH = {
    "roles/research_analyst/role.yaml": `id: research_analyst
version: 1.0.0
kind: core
mission: Research a question with cited sources.
inputs: [request]
output: { artifacts: [research_brief], verdicts: [] }
exits: [done, blocked]
reviewer: engine
models:
  claude-code: { tier: mid, effort: high }
  codex: { tier: mid, effort: high }
tools:
  profile: write_scoped
  write_paths: [".vtc/research/briefs/**"]
  host_web: true
budget: { context_tokens: 80000 }
`,
    "roles/research_analyst/prompt.md": prompt("RESEARCH-LOCKED", "RESEARCH-EDITABLE"),
  };
  const output = compileOk(RESEARCH);

  const claudeTools = (agent: string): string[] => {
    const text = fileOf(output, "claude-code", `agents/${agent}.md`);
    const front = parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "") as {
      tools: string;
    };
    return front.tools.split(", ");
  };

  it("gives the role's Claude Code agent WebSearch and WebFetch", () => {
    expect(claudeTools("vtc-research-analyst")).toEqual(
      expect.arrayContaining(["WebSearch", "WebFetch"]),
    );
  });

  it("gives no other agent a host web tool", () => {
    for (const file of output.targets["claude-code"].filter((f) => f.path.startsWith("agents/"))) {
      const name = file.path.slice("agents/".length, -".md".length);
      if (name === "vtc-research-analyst") continue;
      for (const tool of ["WebSearch", "WebFetch"])
        expect(claudeTools(name), name).not.toContain(tool);
    }
  });

  it("states the host web tools in the generated contract on both hosts", () => {
    const claude = fileOf(output, "claude-code", "agents/vtc-research-analyst.md");
    const codex = parseToml(fileOf(output, "codex", "agents/vtc-research-analyst.toml"))
      .developer_instructions as string;
    for (const text of [claude, codex]) {
      expect(text).toMatch(/^- Host web tools: .*web search and page fetch/m);
      expect(text).toMatch(/untrusted data/);
    }
    expect(fileOf(output, "claude-code", "agents/vtc-qa-judge.md")).not.toMatch(/Host web tools/);
  });

  it("names no web setting in the Codex agent file, which cannot set one (adapters enable it)", () => {
    const toml = parseToml(fileOf(output, "codex", "agents/vtc-research-analyst.toml"));
    expect(Object.keys(toml).sort()).toEqual(
      [
        "description",
        "developer_instructions",
        "features",
        "model_reasoning_effort",
        "name",
      ].sort(),
    );
  });
});

describe("placeholders with digits render (the G2 direction placeholders)", () => {
  it("fills a placeholder whose name has a digit", () => {
    expect(
      renderTemplate("{{g2_directions_min}} or {{a1}}", { g2_directions_min: "2", a1: "x" }),
    ).toEqual({
      ok: true,
      text: "2 or x",
    });
  });

  it("refuses an unknown placeholder whose name has a digit", () => {
    expect(renderTemplate("{{g2_nope}}", {})).toEqual({
      ok: false,
      errors: ["unknown placeholder {{g2_nope}}"],
    });
  });
});
