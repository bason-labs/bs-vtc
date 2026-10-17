import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { engineMcpServer, PROMPT_MARKERS, RoleContractSchema } from "@vtc/shared";
import {
  checkPluginFiles,
  checkRoleContract,
  checkRolePrompt,
  compiledAgentNames,
  COMPILE_TARGETS,
  PLUGIN_SOURCES,
} from "../src/index.js";

const repoFile = (path: string): string =>
  readFileSync(new URL(`../../../${path}`, import.meta.url), "utf8");

describe("@vtc/compiler smoke", () => {
  it("targets both hosts under dist/", () => {
    expect(COMPILE_TARGETS).toEqual({
      "claude-code": "dist/claude-plugin",
      codex: "dist/codex-plugin",
    });
  });
  it("reports role.yaml contract errors with paths", () => {
    const result = checkRoleContract({ id: "qa", version: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith("version:"))).toBe(true);
  });
  it("accepts a valid role contract", () => {
    const result = checkRoleContract({
      id: "spec_verifier",
      version: "1.0.0",
      kind: "core",
      mission: "Judge one acceptance criterion against evidence.",
      inputs: ["acceptance_criterion", "evidence"],
      output: { verdicts: ["pass", "fail", "unknown"] },
      exits: ["done", "unknown"],
      reviewer: "engine",
      models: {
        "claude-code": { tier: "low", effort: "low" },
        codex: { tier: "low", effort: "low" },
      },
      tools: { profile: "read_only" },
      budget: { context_tokens: 8000 },
    });
    expect(result.ok).toBe(true);
  });
});

describe("role prompts and compiled agent names", () => {
  it("splits a well-formed prompt.md", () => {
    const result = checkRolePrompt(
      `${PROMPT_MARKERS.locked}\nMission.\n${PROMPT_MARKERS.editable}\nTips.\n`,
    );
    expect(result).toEqual({ ok: true, locked: "Mission.", editable: "Tips." });
  });
  it("rejects a prompt without the section markers", () => {
    const result = checkRolePrompt("# QA\nWrite tests.\n");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain(PROMPT_MARKERS.locked);
  });
  it("names one agent per mode", () => {
    const base = {
      id: "qa",
      version: "1.0.0",
      kind: "core",
      mission: "Author and judge acceptance tests.",
      inputs: ["task_pack"],
      output: {},
      exits: ["done", "blocked"],
      reviewer: "engine",
      models: {
        "claude-code": { tier: "mid", effort: "medium" },
        codex: { tier: "mid", effort: "medium" },
      },
      tools: { profile: "read_only" },
      budget: { context_tokens: 30000 },
    };
    expect(compiledAgentNames(RoleContractSchema.parse(base))).toEqual(["vtc-qa"]);
    expect(
      compiledAgentNames(RoleContractSchema.parse({ ...base, modes: { author: {}, judge: {} } })),
    ).toEqual(["vtc-qa-author", "vtc-qa-judge"]);
  });
});

describe("plugin sources (AD-16) and the AD-9 gate on emitted files", () => {
  it("the Claude Code plugin registers the engine as `vtc engine --mcp --host claude-code`", () => {
    const mcp = JSON.parse(repoFile(`${PLUGIN_SOURCES["claude-code"]}/.mcp.json`)) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const entry = engineMcpServer("claude-code");
    expect(mcp.mcpServers).toEqual({ [entry.name]: { command: entry.command, args: entry.args } });
  });
  it("flags every forbidden marker in emitted files, with file and line", () => {
    const files = [
      {
        path: "agents/vtc-engineer.md",
        text: "---\nname: vtc-engineer\npermissionMode: acceptEdits\n---\n",
      },
      { path: "agents/vtc-bad.md", text: "---\npermissionMode: bypassPermissions\n---\n" },
      {
        path: "agents/vtc-qa.toml",
        text: 'name = "vtc-qa"\nsandbox_mode = "danger-full-access"\n',
      },
      { path: "skills/x/SKILL.md", text: "Never read\n~/.codex/auth.json\n" },
    ];
    expect(checkPluginFiles(files)).toEqual([
      { path: "agents/vtc-bad.md", line: 2, marker: "bypassPermissions" },
      { path: "agents/vtc-qa.toml", line: 2, marker: "danger-full-access" },
      { path: "skills/x/SKILL.md", line: 2, marker: "auth.json" },
    ]);
  });
});
