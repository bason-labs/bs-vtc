/**
 * Wave 3 (contracts 4.5.0) in the compile step:
 * - Lookback prompt identity (AD-21 rules 1–2, §5 reading 102): every agent's locked and default
 *   editable parts, their SHAs in the manifest, and roles whose agents carry the locked core only;
 * - the role-facing research tools (`ROLE_MCP_TOOLS`, AD-22, AD-4 rule 3) and the skills that go
 *   with them;
 * - the Codex plugin's MCP entry in the portable Agent Plugins format (AD-16 rule 3).
 */
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  effectivePromptSha,
  engineMcpServer,
  ENGINE_MCP_TOOLS,
  LOOKBACK_LIMITS,
  LOOKBACK_REPO,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  ROLE_MCP_TOOLS,
  ScorecardMetricIdSchema,
  type HostId,
  type PluginManifest,
} from "@vtc/shared";
import {
  AGENT_PLUGINS_SCHEMAS,
  CLAUDE_SKILL_DIR,
  CODEX_MCP_FILE,
  claudeEngineToolName,
  compilePlugins,
  EDITABLE_IN_PACK_ROLES,
  EDITABLE_PACK_SECTION,
  PROTOCOL_VARS,
  ROLE_FACING_ENGINE_TOOLS,
  ROLE_SKILLS,
  rolePromptAssetPath,
  TOOL_SKILLS,
  type CompileOptions,
  type CompileOutput,
} from "../src/index.js";
import { fixtureFiles } from "./fixtures.js";

const compile = (
  overrides: Record<string, string | null> = {},
  options: CompileOptions = {},
): ReturnType<typeof compilePlugins> => compilePlugins(fixtureFiles(overrides), options);

const compileOk = (
  overrides: Record<string, string | null> = {},
  options: CompileOptions = {},
): CompileOutput => {
  const result = compile(overrides, options);
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  return result.output;
};

const errorsOf = (
  overrides: Record<string, string | null>,
  options: CompileOptions = {},
): string => {
  const result = compile(overrides, options);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
};

const fileOf = (output: CompileOutput, host: HostId, path: string): string => {
  const found = output.targets[host].find((f) => f.path === path);
  if (found === undefined) throw new Error(`${host} target has no ${path}`);
  return found.text;
};

const manifest = (output: CompileOutput, host: HostId): PluginManifest =>
  PluginManifestSchema.parse(JSON.parse(fileOf(output, host, PLUGIN_MANIFEST_ASSET)));

/** The instructions of an agent exactly as hashed: the Claude body, the Codex TOML string. */
const instructions = (output: CompileOutput, host: HostId, agent: string): string =>
  host === "codex"
    ? (parseToml(fileOf(output, host, `agents/${agent}.toml`)).developer_instructions as string)
    : fileOf(output, host, `agents/${agent}.md`).replace(/^---\n[\s\S]*?\n---\n\n/, "");

const claudeFront = (output: CompileOutput, agent: string): Record<string, unknown> => {
  const text = fileOf(output, "claude-code", `agents/${agent}.md`);
  return parseYaml(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "") as Record<string, unknown>;
};

const HOSTS: readonly HostId[] = ["claude-code", "codex"];

describe("prompt parts and their SHAs (AD-21 rules 1–2)", () => {
  const output = compileOk();

  it.each(HOSTS)(
    "the %s plugin carries every agent's locked and editable part as an asset",
    (host) => {
      const m = manifest(output, host);
      expect(m.agents.length).toBeGreaterThan(0);
      for (const agent of m.agents) {
        const locked = fileOf(output, host, rolePromptAssetPath(agent.name, "locked"));
        const editable = fileOf(output, host, rolePromptAssetPath(agent.name, "editable"));
        expect(locked, agent.name).not.toBe("");
        expect(editable, agent.name).not.toBe("");
        expect(agent.locked_sha256, agent.name).toBe(promptShaFor(locked));
        expect(agent.editable_sha256, agent.name).toBe(promptShaFor(editable));
      }
    },
  );

  it.each(HOSTS)(
    "on %s an agent that carries its editable section hashes to its effective SHA",
    (host) => {
      for (const agent of manifest(output, host).agents) {
        const locked = fileOf(output, host, rolePromptAssetPath(agent.name, "locked"));
        const editable = fileOf(output, host, rolePromptAssetPath(agent.name, "editable"));
        const text = instructions(output, host, agent.name);
        expect(text, agent.name).toBe(`${locked}\n${editable}`);
        expect(agent.prompt_sha256, agent.name).toBe(effectivePromptSha(locked, editable));
      }
    },
  );

  it("splits the parts where Lookback may edit: the editable section only", () => {
    const locked = fileOf(output, "claude-code", rolePromptAssetPath("vtc-qa-author", "locked"));
    const editable = fileOf(
      output,
      "claude-code",
      rolePromptAssetPath("vtc-qa-author", "editable"),
    );
    for (const part of ["QA-SHARED", "AUTHOR-ONLY", "## Contract", "## Returning your result"]) {
      expect(locked).toContain(part);
      expect(editable).not.toContain(part);
    }
    expect(editable).toBe("QA-EDITABLE");
    expect(locked).not.toContain("QA-EDITABLE");
  });

  it("keeps a host's prompt_append in the locked part, which Lookback never edits", () => {
    const codex = fileOf(output, "codex", rolePromptAssetPath("vtc-engineer-frontend", "locked"));
    expect(codex).toContain("CODEX-ONLY-NOTE");
    expect(
      fileOf(output, "codex", rolePromptAssetPath("vtc-engineer-frontend", "editable")),
    ).not.toContain("CODEX-ONLY-NOTE");
  });

  it("gives an engineer profile both editable sections, the Engineer's first", () => {
    expect(
      fileOf(output, "claude-code", rolePromptAssetPath("vtc-engineer-frontend", "editable")),
    ).toBe("ENGINEER-EDITABLE\n\nFRONTEND-EDITABLE");
  });

  it("names the assets by agent and part, under the plugin's vtc/ directory", () => {
    expect(rolePromptAssetPath("vtc-qa-judge", "locked")).toBe(
      "vtc/prompts/vtc-qa-judge/locked.md",
    );
    expect(rolePromptAssetPath("vtc-qa-judge", "editable")).toBe(
      "vtc/prompts/vtc-qa-judge/editable.md",
    );
    expect(() => rolePromptAssetPath("../x", "locked")).toThrow();
  });
});

describe("roles whose agents carry the locked core only (§5 reading 102)", () => {
  it("switches exactly one role first, for the A/A comparison before every role", () => {
    expect(EDITABLE_IN_PACK_ROLES).toEqual(["spec_verifier"]);
  });

  const output = compileOk({}, { editableInPack: ["qa"] });

  it.each(HOSTS)("on %s a switched agent carries no editable section", (host) => {
    for (const agent of ["vtc-qa-author", "vtc-qa-judge"]) {
      const text = instructions(output, host, agent);
      const locked = fileOf(output, host, rolePromptAssetPath(agent, "locked"));
      expect(text, agent).toBe(locked);
      expect(text, agent).not.toContain("QA-EDITABLE");
      expect(fileOf(output, host, rolePromptAssetPath(agent, "editable"))).toBe("QA-EDITABLE");
    }
  });

  it.each(HOSTS)("on %s a switched agent's prompt SHA is its locked SHA", (host) => {
    const m = manifest(output, host);
    for (const agent of m.agents) {
      const switched = agent.role === "qa";
      expect(agent.prompt_sha256 === agent.locked_sha256, agent.name).toBe(switched);
    }
  });

  it("tells a switched agent where its heuristics are: first in the task pack", () => {
    const text = instructions(output, "claude-code", "vtc-qa-judge");
    expect(text).toContain(`\`${EDITABLE_PACK_SECTION}\``);
    expect(text).toMatch(/first in your task pack/);
    expect(instructions(output, "claude-code", "vtc-engineer")).not.toContain(
      EDITABLE_PACK_SECTION,
    );
  });
});

describe("role-facing research tools (ROLE_MCP_TOOLS, AD-22, AD-4 rule 3)", () => {
  const ARCHITECT = {
    "roles/architect/role.yaml": `id: architect
version: 1.0.0
kind: core
mission: Decide the architecture.
inputs: [spec, research_brief]
output: { artifacts: [architecture], verdicts: [] }
exits: [done, blocked]
reviewer: engine
models:
  claude-code: { tier: top, effort: high }
  codex: { tier: top, effort: high }
tools:
  profile: write_scoped
  write_paths: [".vtc/architecture/**"]
  engine_tools: [research_fetch, fact_lookup, fact_propose]
budget: { context_tokens: 80000 }
`,
    "roles/architect/prompt.md":
      "<!-- vtc:locked -->\nARCHITECT-LOCKED\n<!-- vtc:editable -->\nARCHITECT-EDITABLE\n",
    "skills/architect/SKILL.md":
      "---\nname: architect\ndescription: Architect method references.\n---\n\nRead ${CLAUDE_SKILL_DIR}/references/adr.md for an ADR.\n",
    "skills/architect/references/adr.md": "# ADR template\n",
    "skills/research-fetch/SKILL.md":
      "---\nname: research-fetch\ndescription: Fetch research sources.\n---\n\nUse research_fetch.\n",
    "skills/research-facts/SKILL.md":
      "---\nname: research-facts\ndescription: Cite and propose facts.\n---\n\nUse fact_lookup.\n",
  };

  it("is exactly the frozen role-facing list", () => {
    expect(ROLE_FACING_ENGINE_TOOLS).toEqual(ROLE_MCP_TOOLS.map((t) => t.name));
    for (const lead of ENGINE_MCP_TOOLS.map((t) => t.name)) {
      expect(ROLE_FACING_ENGINE_TOOLS).not.toContain(lead);
    }
  });

  it("gives a Claude Code agent the tools its contract declares, by their plugin names", () => {
    const tools = String(claudeFront(compileOk(ARCHITECT), "vtc-architect").tools).split(", ");
    for (const tool of ROLE_MCP_TOOLS) expect(tools).toContain(claudeEngineToolName(tool.name));
    expect(tools).not.toContain(claudeEngineToolName("next"));
  });

  it("lists the tools in the agent's contract section", () => {
    const text = instructions(compileOk(ARCHITECT), "codex", "vtc-architect");
    expect(text).toContain("- Engine tools: research_fetch, fact_lookup, fact_propose");
  });

  it("preloads the skills that teach the tools, and the role's own skill, on Claude Code", () => {
    expect(TOOL_SKILLS).toEqual({
      research_fetch: "research-fetch",
      fact_lookup: "research-facts",
      fact_propose: "research-facts",
    });
    expect(ROLE_SKILLS).toEqual({ architect: ["architect"] });
    expect(claudeFront(compileOk(ARCHITECT), "vtc-architect").skills).toEqual([
      "vtc:architect",
      "vtc:research-facts",
      "vtc:research-fetch",
    ]);
    // an agent with neither gets no skills key at all
    expect(claudeFront(compileOk(ARCHITECT), "vtc-qa-judge").skills).toBeUndefined();
  });

  it("names no skill in a Codex agent: Codex lists plugin skills to every session", () => {
    const toml = parseToml(fileOf(compileOk(ARCHITECT), "codex", "agents/vtc-architect.toml"));
    expect(toml.skills).toBeUndefined();
  });

  it("fails when a declared tool's skill or a role's own skill is missing", () => {
    expect(errorsOf({ ...ARCHITECT, "skills/research-fetch/SKILL.md": null })).toMatch(
      /roles\/architect: engine tool research_fetch needs the skill skills\/research-fetch/,
    );
    expect(
      errorsOf({
        ...ARCHITECT,
        "skills/architect/SKILL.md": null,
        "skills/architect/references/adr.md": null,
      }),
    ).toMatch(/roles\/architect: needs its skill skills\/architect/);
  });

  it("points skill references at the skill directory on each host", () => {
    const output = compileOk(ARCHITECT);
    expect(fileOf(output, "claude-code", "skills/architect/SKILL.md")).toContain(
      `${CLAUDE_SKILL_DIR}/references/adr.md`,
    );
    const codex = fileOf(output, "codex", "skills/architect/SKILL.md");
    expect(codex).not.toContain(CLAUDE_SKILL_DIR);
    expect(codex).toContain("Read references/adr.md for an ADR.");
  });
});

describe("the Codex plugin in the portable Agent Plugins format (AD-16 rule 3)", () => {
  const output = compileOk();

  it("registers the engine in mcp.json with the stdio transport type", () => {
    const entry = engineMcpServer("codex");
    expect(CODEX_MCP_FILE).toBe("mcp.json");
    expect(JSON.parse(fileOf(output, "codex", CODEX_MCP_FILE))).toEqual({
      $schema: AGENT_PLUGINS_SCHEMAS.mcp,
      mcpServers: {
        [entry.name]: { type: "stdio", command: entry.command, args: entry.args },
      },
    });
    expect(output.targets.codex.map((f) => f.path)).not.toContain(".mcp.json");
  });

  it("keeps the Claude Code plugin's .mcp.json in Claude Code's own format", () => {
    const entry = engineMcpServer("claude-code");
    expect(JSON.parse(fileOf(output, "claude-code", ".mcp.json"))).toEqual({
      mcpServers: { [entry.name]: { command: entry.command, args: entry.args } },
    });
  });

  it("refuses a hand-written Codex MCP entry under either name", () => {
    for (const path of ["plugins/codex/mcp.json", "plugins/codex/.mcp.json"]) {
      expect(errorsOf({ [path]: "{}\n" })).toMatch(/generated from engineMcpServer/);
    }
  });

  it("requires the portable manifest's $schema and a valid plugin name", () => {
    expect(errorsOf({ "plugins/codex/plugin.json": '{ "name": "vtc" }\n' })).toMatch(
      /plugins\/codex\/plugin.json: \$schema must be https:\/\/agent-plugins.org\/schemas\/1.0.0\/plugin.schema.json/,
    );
    expect(
      errorsOf({
        "plugins/codex/plugin.json": `{ "$schema": "${AGENT_PLUGINS_SCHEMAS.plugin}", "name": "Not--Valid" }\n`,
      }),
    ).toMatch(/plugins\/codex\/plugin.json: name must be the plugin name vtc/);
    expect(errorsOf({ "plugins/codex/plugin.json": "{" })).toMatch(
      /plugins\/codex\/plugin.json: not valid JSON/,
    );
  });
});

describe("placeholders for the wave-3 prompts", () => {
  it("fills the Lookback limits, metric ids and places from @vtc/shared", () => {
    expect(PROTOCOL_VARS.scorecard_metrics).toBe(ScorecardMetricIdSchema.options.join(", "));
    expect(PROTOCOL_VARS.max_proposal_changes).toBe(String(LOOKBACK_LIMITS.maxProposalChanges));
    expect(PROTOCOL_VARS.lookback_proposals_dir).toBe(LOOKBACK_REPO.proposalsDir);
  });

  it("fills the research tool names, fetchers and fact statuses", () => {
    expect(PROTOCOL_VARS.role_mcp_tools).toBe(ROLE_MCP_TOOLS.map((t) => t.name).join(", "));
    expect(PROTOCOL_VARS.fetchers).toMatch(/^eol, depsdev, osv, /);
    expect(PROTOCOL_VARS.fact_statuses).toBe("verified, unverified, stale, conflicting, waived");
  });
});
