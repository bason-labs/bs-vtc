import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import type { RoleTools } from "@vtc/shared";
import {
  CLAUDE_MODEL_ALIASES,
  claudeEngineToolName,
  claudeToolsFor,
  codexSandboxFor,
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
      model: CLAUDE_MODEL_ALIASES.mid,
      effort: "medium",
    });
    expect(md.endsWith("# Mission\n\nWrite tests.\n")).toBe(true);
    expect(md).not.toContain("permissionMode");
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
  it("renders name, description, effort, sandbox and instructions", () => {
    const parsed = parseToml(renderCodexAgent(agent()));
    expect(parsed).toEqual({
      name: "vtc-qa-author",
      description: 'VTC role agent "qa" (author mode). Writes acceptance tests.',
      model_reasoning_effort: "medium",
      sandbox_mode: "workspace-write",
      developer_instructions: "# Mission\n\nWrite tests.\n",
    });
  });

  it("uses a read-only sandbox for read-only roles and pins a model only when role.yaml does", () => {
    expect(codexSandboxFor(tools("read_only"))).toBe("read-only");
    expect(codexSandboxFor(tools("code_sandboxed"))).toBe("workspace-write");
    const parsed = parseToml(
      renderCodexAgent(
        agent({ tools: tools("read_only"), model: { tier: "low", effort: "low", model: "m-1" } }),
      ),
    );
    expect(parsed.sandbox_mode).toBe("read-only");
    expect(parsed.model).toBe("m-1");
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
