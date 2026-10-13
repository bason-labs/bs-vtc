import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { HUMAN_ONLY_TOOLS, type RoleTools } from "@vtc/shared";
import {
  CLAUDE_DENIED_TOOLS,
  CLAUDE_MODEL_ALIASES,
  claudeEngineToolName,
  claudeToolsFor,
  codexFeaturesFor,
  renderClaudeAgent,
  renderCodexAgent,
  tomlString,
  type CompiledAgent,
} from "../src/index.js";

const tools = (profile: RoleTools["profile"], engineTools: string[] = []): RoleTools => ({
  profile,
  write_paths: profile === "write_scoped" ? [".vtc/spec/**"] : [],
  engine_tools: engineTools,
});

const agent = (over: Partial<CompiledAgent> = {}): CompiledAgent => ({
  name: "vtc-qa-author",
  role: "qa",
  mode: "author",
  kind: "core",
  discipline: undefined,
  roleVersion: "1.2.0",
  description: 'VTC role agent "qa" (author mode). Writes acceptance tests.',
  tools: tools("write_scoped"),
  model: { tier: "mid", effort: "medium" },
  instructions: "# Mission\n\nWrite tests.\n",
  ...over,
});

const frontmatter = (md: string): Record<string, unknown> => {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(md);
  if (match?.[1] === undefined) throw new Error("no frontmatter");
  return parseYaml(match[1]) as Record<string, unknown>;
};

describe("Claude Code agent (.md)", () => {
  it("maps tool profiles to an explicit tool allowlist", () => {
    expect(claudeToolsFor(tools("read_only"))).toEqual(["Read", "Grep", "Glob"]);
    expect(claudeToolsFor(tools("write_scoped"))).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Write",
      "Edit",
    ]);
    expect(claudeToolsFor(tools("code_sandboxed"))).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Write",
      "Edit",
      "Bash",
    ]);
    expect(claudeToolsFor(tools("read_only", ["repo_map"]))).toEqual([
      "Read",
      "Grep",
      "Glob",
      claudeEngineToolName("repo_map"),
    ]);
    expect(claudeEngineToolName("repo_map")).toBe("mcp__plugin_vtc_vtc__repo_map");
  });

  it("renders frontmatter and the instructions as the body", () => {
    const md = renderClaudeAgent(agent());
    expect(frontmatter(md)).toEqual({
      name: "vtc-qa-author",
      description: 'VTC role agent "qa" (author mode). Writes acceptance tests.',
      tools: "Read, Grep, Glob, Write, Edit",
      disallowedTools: CLAUDE_DENIED_TOOLS.join(", "),
      model: CLAUDE_MODEL_ALIASES.mid,
      effort: "medium",
    });
    expect(md.endsWith("# Mission\n\nWrite tests.\n")).toBe(true);
    expect(md).not.toContain("permissionMode");
  });

  it("names only bare tools in disallowedTools: a specifier would remove the whole tool (reading 81)", () => {
    // code.claude.com/docs/en/sub-agents: "An entry with a specifier, such as `Bash(git push *)`,
    // still removes the whole tool"; path and command rules live in permissions.deny instead
    expect(CLAUDE_DENIED_TOOLS).toEqual(HUMAN_ONLY_TOOLS.map(claudeEngineToolName));
    for (const profile of ["read_only", "write_scoped", "code_sandboxed"] as const) {
      const front = frontmatter(renderClaudeAgent(agent({ tools: tools(profile) })));
      const denied = String(front.disallowedTools).split(", ");
      expect(denied, profile).toEqual(CLAUDE_DENIED_TOOLS);
      expect(
        denied.filter((t) => /[()]/.test(t)),
        profile,
      ).toEqual([]);
      // the profile's own tools all survive: nothing in disallowedTools removes Read/Edit/Bash
      const allowed = String(front.tools).split(", ");
      expect(
        allowed.filter((t) => denied.includes(t)),
        profile,
      ).toEqual([]);
    }
    expect(
      String(frontmatter(renderClaudeAgent(agent({ tools: tools("code_sandboxed") }))).tools),
    ).toBe("Read, Grep, Glob, Write, Edit, Bash");
  });

  it("denies every human-only engine tool to every agent by its plugin name (D-an, reading 71)", () => {
    for (const tool of HUMAN_ONLY_TOOLS) {
      expect(CLAUDE_DENIED_TOOLS).toContain(claudeEngineToolName(tool));
    }
  });

  it("refuses to render a human-only engine tool into an agent's tools (D-an)", () => {
    for (const tool of HUMAN_ONLY_TOOLS) {
      for (const profile of ["read_only", "write_scoped", "code_sandboxed"] as const) {
        expect(() => claudeToolsFor(tools(profile, [tool])), tool).toThrow(/human/);
        expect(() => renderClaudeAgent(agent({ tools: tools(profile, [tool]) })), tool).toThrow(
          /human/,
        );
        expect(() => renderCodexAgent(agent({ tools: tools(profile, [tool]) })), tool).toThrow(
          /human/,
        );
      }
    }
  });

  it("maps tiers to model aliases and honours an explicit model id", () => {
    expect(CLAUDE_MODEL_ALIASES).toEqual({ top: "opus", mid: "sonnet", low: "haiku" });
    const pinned = renderClaudeAgent(
      agent({ model: { tier: "top", effort: "high", model: "claude-opus-x" } }),
    );
    expect(frontmatter(pinned).model).toBe("claude-opus-x");
  });
});

describe("Codex agent (.toml)", () => {
  it("renders name, description, effort, instructions and the features it turns off", () => {
    const parsed = parseToml(renderCodexAgent(agent()));
    expect(parsed).toEqual({
      name: "vtc-qa-author",
      description: 'VTC role agent "qa" (author mode). Writes acceptance tests.',
      model_reasoning_effort: "medium",
      developer_instructions: "# Mission\n\nWrite tests.\n",
      features: { shell_tool: false, request_permissions_tool: false },
    });
  });

  it("sets no sandbox, network or MCP key: a Codex agent file cannot override them (reading 82)", () => {
    // developers.openai.com/codex/subagents: custom agents "inherit the parent's permissions,
    // provider, and MCP servers; a custom agent file can't override those settings"
    for (const profile of ["read_only", "write_scoped", "code_sandboxed"] as const) {
      const text = renderCodexAgent(agent({ tools: tools(profile, ["repo_map"]) }));
      expect(text, profile).not.toMatch(
        /sandbox_mode|sandbox_workspace_write|mcp_servers|approval_policy/,
      );
    }
  });

  it("keeps the shell only for the Engineer family, and the permission-request tool for none", () => {
    expect(codexFeaturesFor(tools("read_only"))).toEqual({
      shell_tool: false,
      request_permissions_tool: false,
    });
    expect(codexFeaturesFor(tools("write_scoped"))).toEqual({
      shell_tool: false,
      request_permissions_tool: false,
    });
    expect(codexFeaturesFor(tools("code_sandboxed"))).toEqual({ request_permissions_tool: false });
  });

  it("sets only the reasoning effort (D-h)", () => {
    const parsed = parseToml(
      renderCodexAgent(
        agent({ tools: tools("read_only"), model: { tier: "low", effort: "low", model: "m-1" } }),
      ),
    );
    expect(parsed.model).toBeUndefined();
    expect(parsed.model_reasoning_effort).toBe("low");
  });

  it("round-trips awkward instruction text exactly", () => {
    const nasty = 'quotes " and \'\'\' and """ and \\ back\\slash\n\ttab\r\nend \u0001';
    const parsed = parseToml(renderCodexAgent(agent({ instructions: nasty })));
    expect(parsed.developer_instructions).toBe(nasty);
  });
});

describe("tomlString", () => {
  it.each([
    "plain",
    'with "quotes"',
    "back\\slash",
    "line\nbreak",
    "\u007f del and \u001f unit separator",
    "unicode ✓ é",
  ])("round-trips %j", (value) => {
    expect(parseToml(`v = ${tomlString(value)}`).v).toBe(value);
  });
});
