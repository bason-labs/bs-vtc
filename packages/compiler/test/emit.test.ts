import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  engineMcpServer,
  HUMAN_ONLY_TOOLS,
  REPO_ROLE_DENIED,
  ROLE_DENIED_VTC,
  type RoleTools,
} from "@vtc/shared";
import {
  CLAUDE_DENIED_TOOLS,
  CLAUDE_HOME_FILE_DENIES_END,
  CLAUDE_MODEL_ALIASES,
  CLAUDE_SHELL_HOME_DENIES,
  claudeEngineToolName,
  claudeToolsFor,
  codexSandboxFor,
  renderClaudeAgent,
  renderCodexAgent,
  tomlString,
  VTC_HOME_SHELL_SPELLINGS,
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

  it("denies running `vtc calibrate` and writing the guarded VTC home globs (D-w, reading 43)", () => {
    expect(CLAUDE_DENIED_TOOLS.slice(0, CLAUDE_HOME_FILE_DENIES_END)).toEqual([
      "Bash(vtc calibrate:*)",
      "Edit(~/.vtc/allowlists/**)",
      "Write(~/.vtc/allowlists/**)",
      "Edit(~/.vtc/osv-db/**)",
      "Write(~/.vtc/osv-db/**)",
      "Edit(~/.vtc/hidden/**)",
      "Write(~/.vtc/hidden/**)",
      // D-ap (reading 73): everything under the VTC home that is later run or trusted
      "Edit(~/.vtc/scanners/**)",
      "Write(~/.vtc/scanners/**)",
      "Edit(~/.vtc/claude-marketplace/**)",
      "Write(~/.vtc/claude-marketplace/**)",
      "Edit(~/.vtc/plugins/**)",
      "Write(~/.vtc/plugins/**)",
      "Edit(~/.vtc/engines/**)",
      "Write(~/.vtc/engines/**)",
      "Edit(~/.vtc/run/**)",
      "Write(~/.vtc/run/**)",
      "Edit(~/.vtc/config.yaml)",
      "Write(~/.vtc/config.yaml)",
      "Edit(~/.vtc/token)",
      "Write(~/.vtc/token)",
      // plugin-only mode builds no adapter profile: the agent carries its own read denies,
      // built from ROLE_DENIED_VTC.homeReadDeny (D-an, reading 71)
      "Read(~/.vtc/token)",
      "Read(~/.vtc/run/**)",
      "Read(~/.vtc/hidden/**)",
      "Read(~/.codex/**)",
      // reading 79: the repo's gate checkouts (hidden tests) and raw gate output, and the run
      // config, at any depth below the session's directory
      "Read(**/.vtc/state/checkouts/**)",
      "Read(**/.vtc/state/gates/**)",
      "Edit(**/.vtc/state/checkouts/**)",
      "Write(**/.vtc/state/checkouts/**)",
      "Edit(**/.vtc/state/gates/**)",
      "Write(**/.vtc/state/gates/**)",
      "Edit(**/.vtc/project.yaml)",
      "Write(**/.vtc/project.yaml)",
      "Edit(**/.vtc/gates.yml)",
      "Write(**/.vtc/gates.yml)",
    ]);
    // derived from the shared lists, so a new entry there reaches every agent
    expect(CLAUDE_HOME_FILE_DENIES_END).toBe(
      ROLE_DENIED_VTC.subcommands.length +
        2 * ROLE_DENIED_VTC.homeWriteDeny.length +
        ROLE_DENIED_VTC.homeReadDeny.length +
        1 +
        REPO_ROLE_DENIED.readDeny.length +
        2 * REPO_ROLE_DENIED.writeDeny.length,
    );
    expect(CLAUDE_DENIED_TOOLS).toEqual([
      ...CLAUDE_DENIED_TOOLS.slice(0, CLAUDE_HOME_FILE_DENIES_END),
      ...CLAUDE_SHELL_HOME_DENIES,
      ...HUMAN_ONLY_TOOLS.map(claudeEngineToolName),
    ]);
    expect(new Set(CLAUDE_DENIED_TOOLS).size).toBe(CLAUDE_DENIED_TOOLS.length);
    for (const profile of ["read_only", "write_scoped", "code_sandboxed"] as const) {
      const front = frontmatter(renderClaudeAgent(agent({ tools: tools(profile) })));
      expect(String(front.disallowedTools).split(", "), profile).toEqual(CLAUDE_DENIED_TOOLS);
    }
  });

  it("denies shell commands that name a guarded VTC home path, by every home spelling (D-an, D-ap)", () => {
    const roots = [
      ...new Set(
        [...ROLE_DENIED_VTC.homeWriteDeny, ...ROLE_DENIED_VTC.homeReadDeny].map((glob) =>
          glob.replace(/\/\*\*$/, ""),
        ),
      ),
    ];
    expect(VTC_HOME_SHELL_SPELLINGS).toEqual([
      "~/.vtc",
      "$HOME/.vtc",
      "${HOME}/.vtc",
      "$VTC_HOME",
      "${VTC_HOME}",
    ]);
    expect(CLAUDE_SHELL_HOME_DENIES).toEqual(
      roots.flatMap((root) => VTC_HOME_SHELL_SPELLINGS.map((home) => `Bash(*${home}/${root}*)`)),
    );
    expect(CLAUDE_SHELL_HOME_DENIES).toContain("Bash(*~/.vtc/token*)");
    expect(CLAUDE_SHELL_HOME_DENIES).toContain("Bash(*$HOME/.vtc/run*)");
    expect(CLAUDE_SHELL_HOME_DENIES).toContain("Bash(*${VTC_HOME}/allowlists*)");
  });

  it("matches shell reads and writes of guarded paths, and leaves the project's .vtc/ alone", () => {
    // Claude Code Bash rules: `*` stands for any text, spaces included; the rest is literal. A
    // trailing `:*` is a trailing ` *`, and a trailing ` *` that is the only `*` also matches
    // the bare command.
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = (rule: string, command: string): boolean => {
      const raw = /^Bash\((.*)\)$/.exec(rule)?.[1];
      if (raw === undefined) return false;
      const body = raw.endsWith(":*") ? `${raw.slice(0, -2)} *` : raw;
      if (body.endsWith(" *") && body.indexOf("*") === body.length - 1) {
        return new RegExp(`^${escape(body.slice(0, -2))}( .*)?$`).test(command);
      }
      return new RegExp(`^${body.split("*").map(escape).join(".*")}$`).test(command);
    };
    const denied = (command: string): boolean =>
      CLAUDE_DENIED_TOOLS.some((rule) => matches(rule, command));
    for (const command of [
      "cat ~/.vtc/token",
      "base64 < $HOME/.vtc/token",
      "nc -U ~/.vtc/run/abc.sock",
      'echo \'{"client":"cli"}\' | socat - UNIX-CONNECT:${HOME}/.vtc/run/abc.sock',
      "echo '{}' > ~/.vtc/allowlists/k.json",
      "cp evil ~/.vtc/scanners/semgrep/semgrep",
      "sed -i s/a/b/ $VTC_HOME/config.yaml",
      "rm -rf ${VTC_HOME}/osv-db",
      "ls ~/.vtc/hidden/T-1",
      "tee ~/.vtc/claude-marketplace/plugins/vtc/hooks/hooks.json",
      "vtc calibrate",
      "vtc calibrate --yes",
    ]) {
      expect(denied(command), command).toBe(true);
    }
    for (const command of [
      "pnpm test",
      "cat .vtc/config.yaml",
      "ls .vtc/runs",
      "git diff -- .vtc/state",
      "vtc status",
    ]) {
      expect(denied(command), command).toBe(false);
    }
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
  it("renders name, description, effort, sandbox and instructions", () => {
    const parsed = parseToml(renderCodexAgent(agent()));
    expect(parsed).toEqual({
      name: "vtc-qa-author",
      description: 'VTC role agent "qa" (author mode). Writes acceptance tests.',
      model_reasoning_effort: "medium",
      sandbox_mode: "workspace-write",
      developer_instructions: "# Mission\n\nWrite tests.\n",
      sandbox_workspace_write: { network_access: false },
      mcp_servers: { vtc: { command: "vtc", args: engineMcpServer("codex").args, enabled: false } },
    });
  });

  it("limits the agent's engine bridge to its own engine tools, never the Lead's", () => {
    const parsed = parseToml(renderCodexAgent(agent({ tools: tools("read_only", ["repo_map"]) })));
    expect(parsed.mcp_servers).toEqual({
      vtc: { command: "vtc", args: engineMcpServer("codex").args, enabled_tools: ["repo_map"] },
    });
  });

  it("uses a read-only sandbox for read-only roles and sets only the reasoning effort (D-h)", () => {
    expect(codexSandboxFor(tools("read_only"))).toBe("read-only");
    expect(codexSandboxFor(tools("code_sandboxed"))).toBe("workspace-write");
    const parsed = parseToml(
      renderCodexAgent(
        agent({ tools: tools("read_only"), model: { tier: "low", effort: "low", model: "m-1" } }),
      ),
    );
    expect(parsed.sandbox_mode).toBe("read-only");
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
