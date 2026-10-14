import { createHash } from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  AD9_FORBIDDEN_MARKERS,
  engineMcpServer,
  EvidenceTypeSchema,
  HUMAN_ONLY_TOOLS,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  ROLE_CONTRACTS_ASSET,
  RoleContractSchema,
  TASK_PACK_SECTIONS,
  VTC_HOOK,
  vtcHookCommand,
  type HostId,
  type PluginManifest,
  type VtcHookEvent,
} from "@vtc/shared";
import {
  checkEmitted,
  compilePlugins,
  EXIT_MEANINGS,
  HOOKS_FILE,
  loadRoles,
  type CompileOutput,
  type EmittedFile,
} from "../src/index.js";
import { fixtureFiles } from "./fixtures.js";

const compileOk = (overrides: Record<string, string | null> = {}): CompileOutput => {
  const result = compilePlugins(fixtureFiles(overrides));
  if (!result.ok) throw new Error(result.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  return result.output;
};

const errorsOf = (overrides: Record<string, string | null>): string => {
  const result = compilePlugins(fixtureFiles(overrides));
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.errors.map((e) => `${e.path}: ${e.message}`).join("\n");
};

const file = (output: CompileOutput, host: HostId, path: string): string => {
  const found = output.targets[host].find((f: EmittedFile) => f.path === path);
  if (found === undefined) throw new Error(`${host} target has no ${path}`);
  return found.text;
};

const manifest = (output: CompileOutput, host: HostId): PluginManifest =>
  PluginManifestSchema.parse(JSON.parse(file(output, host, PLUGIN_MANIFEST_ASSET)));

const body = (md: string): string => md.replace(/^---\n[\s\S]*?\n---\n\n/, "");

describe("compilePlugins: target layout", () => {
  const output = compileOk();

  it("emits the Claude Code plugin tree", () => {
    expect(output.targets["claude-code"].map((f) => f.path)).toEqual([
      ".claude-plugin/plugin.json",
      ".mcp.json",
      "NOTICE",
      "agents/vtc-engineer-frontend.md",
      "agents/vtc-engineer.md",
      "agents/vtc-lens-db.md",
      "agents/vtc-qa-author.md",
      "agents/vtc-qa-judge.md",
      "commands/vtc.md",
      "hooks/hooks.json",
      "skills/domain-desktop/SKILL.md",
      "skills/lead/SKILL.md",
      "skills/lens-db/SKILL.md",
      "skills/stack-react-next/SKILL.md",
      "skills/stack-react-next/references/testing.md",
      "vtc-manifest.json",
      "vtc/prompts/vtc-engineer-frontend/editable.md",
      "vtc/prompts/vtc-engineer-frontend/locked.md",
      "vtc/prompts/vtc-engineer/editable.md",
      "vtc/prompts/vtc-engineer/locked.md",
      "vtc/prompts/vtc-lens-db/editable.md",
      "vtc/prompts/vtc-lens-db/locked.md",
      "vtc/prompts/vtc-qa-author/editable.md",
      "vtc/prompts/vtc-qa-author/locked.md",
      "vtc/prompts/vtc-qa-judge/editable.md",
      "vtc/prompts/vtc-qa-judge/locked.md",
      "vtc/role-contracts.json",
      "vtc/templates/auto-issue.md",
      "vtc/templates/auto-pr.md",
      "vtc/templates/changelog-entry.md",
    ]);
  });

  it("emits the Codex plugin tree, with the /vtc command as a skill", () => {
    expect(output.targets.codex.map((f) => f.path)).toEqual([
      "NOTICE",
      "agents/vtc-engineer-frontend.toml",
      "agents/vtc-engineer.toml",
      "agents/vtc-lens-db.toml",
      "agents/vtc-qa-author.toml",
      "agents/vtc-qa-judge.toml",
      "hooks/hooks.json",
      "mcp.json",
      "plugin.json",
      "skills/domain-desktop/SKILL.md",
      "skills/lead/SKILL.md",
      "skills/lens-db/SKILL.md",
      "skills/stack-react-next/SKILL.md",
      "skills/stack-react-next/references/testing.md",
      "skills/vtc/SKILL.md",
      "vtc-manifest.json",
      "vtc/prompts/vtc-engineer-frontend/editable.md",
      "vtc/prompts/vtc-engineer-frontend/locked.md",
      "vtc/prompts/vtc-engineer/editable.md",
      "vtc/prompts/vtc-engineer/locked.md",
      "vtc/prompts/vtc-lens-db/editable.md",
      "vtc/prompts/vtc-lens-db/locked.md",
      "vtc/prompts/vtc-qa-author/editable.md",
      "vtc/prompts/vtc-qa-author/locked.md",
      "vtc/prompts/vtc-qa-judge/editable.md",
      "vtc/prompts/vtc-qa-judge/locked.md",
      "vtc/role-contracts.json",
      "vtc/templates/auto-issue.md",
      "vtc/templates/auto-pr.md",
      "vtc/templates/changelog-entry.md",
    ]);
    const skill = file(output, "codex", "skills/vtc/SKILL.md");
    expect(skill).toMatch(/^---\nname: vtc\ndescription: Drive VTC\.\n---\n/);
    expect(skill).toContain("Use the lead skill.");
    expect(skill).not.toContain("$ARGUMENTS");
  });

  it("registers the engine on both hosts as engineMcpServer(host) (AD-16 rule 3)", () => {
    const claude = engineMcpServer("claude-code");
    expect(JSON.parse(file(output, "claude-code", ".mcp.json"))).toEqual({
      mcpServers: { [claude.name]: { command: claude.command, args: claude.args } },
    });
    // the portable Agent Plugins format: a root mcp.json with a transport type per server
    const codex = engineMcpServer("codex");
    expect(JSON.parse(file(output, "codex", "mcp.json"))).toMatchObject({
      mcpServers: { [codex.name]: { type: "stdio", command: codex.command, args: codex.args } },
    });
  });

  it("carries the third-party NOTICE into both plugins", () => {
    expect(file(output, "claude-code", "NOTICE")).toContain("agency-agents (MIT)");
    expect(file(output, "codex", "NOTICE")).toContain("agency-agents (MIT)");
  });
});

describe("compilePlugins: agent instructions", () => {
  const output = compileOk();
  const claude = (name: string): string => body(file(output, "claude-code", `agents/${name}.md`));
  const codex = (name: string): string =>
    parseToml(file(output, "codex", `agents/${name}.toml`)).developer_instructions as string;

  it("keeps only the dispatched mode's blocks", () => {
    expect(claude("vtc-qa-author")).toContain("AUTHOR-ONLY");
    expect(claude("vtc-qa-author")).not.toContain("JUDGE-ONLY");
    expect(claude("vtc-qa-judge")).toContain("JUDGE-ONLY");
    expect(claude("vtc-qa-judge")).not.toContain("AUTHOR-ONLY");
  });

  it("orders locked core, generated contract, result protocol, then the editable section", () => {
    const text = claude("vtc-qa-author");
    const order = ["QA-SHARED", "## Contract", "## Returning your result", "QA-EDITABLE"].map(
      (needle) => text.indexOf(needle),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("renders the effective contract of each mode", () => {
    expect(claude("vtc-qa-author")).toContain("- Exits: done, blocked, spec_conflict");
    expect(claude("vtc-qa-author")).toContain(
      `  - \`spec_conflict\`: ${EXIT_MEANINGS.spec_conflict}`,
    );
    expect(claude("vtc-qa-judge")).not.toContain("  - `spec_conflict`:");
    expect(claude("vtc-qa-author")).toContain("- Output artifact types: acceptance_test");
    expect(claude("vtc-qa-judge")).toContain("- Verdicts: pass, fail, unknown");
    expect(claude("vtc-qa-judge")).toContain("- Tools: read-only");
  });

  it("states tool limits as instructions and lists the write paths of a write-scoped mode", () => {
    const author = claude("vtc-qa-author");
    expect(author).toContain("run no shell command");
    expect(author).toContain("- Write paths (role.yaml): tests/acceptance/**");
    expect(claude("vtc-qa-judge")).not.toContain("- Write paths");
    expect(claude("vtc-engineer")).not.toContain("run no shell command");
  });

  it("sets no per-agent MCP table in a Codex role agent: Codex would ignore it (reading 82)", () => {
    for (const name of ["vtc-qa-author", "vtc-engineer", "vtc-lens-db"]) {
      const toml = parseToml(file(output, "codex", `agents/${name}.toml`));
      expect(toml.mcp_servers).toBeUndefined();
      expect(toml.sandbox_mode).toBeUndefined();
    }
  });

  it("fills the shared protocol from the frozen contracts", () => {
    const text = claude("vtc-engineer");
    expect(text).toContain(`Evidence types: ${EvidenceTypeSchema.options.join(", ")}.`);
    expect(text).toContain(`Pack sections: ${TASK_PACK_SECTIONS.join(", ")}.`);
  });

  it("builds an engineer profile on the shared Engineer contract (§5.2a)", () => {
    const text = claude("vtc-engineer-frontend");
    // the Engineer's whole prompt first, in the locked part; the profile's own section last
    const order = ["ENGINEER-LOCKED", "ENGINEER-EDITABLE", "FRONTEND-LOCKED", "FRONTEND-EDITABLE"];
    const positions = order.map((needle) => text.indexOf(needle));
    expect(positions.every((index) => index >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("has a profile report role engineer, the family's shared result contract (reading 38)", () => {
    for (const text of [claude("vtc-engineer-frontend"), codex("vtc-engineer-frontend")]) {
      expect(text).toContain(
        "- Role: engineer, frontend profile engineer_frontend (version 1.0.0); your result's `role` is `engineer`",
      );
      expect(text).not.toContain("- Role: engineer_frontend");
    }
    expect(claude("vtc-engineer")).toContain("- Role: engineer (version 1.0.0)");
  });

  it("builds a lens reviewer from the shared lens procedure and its lens skill (§5.3)", () => {
    const text = claude("vtc-lens-db");
    for (const needle of ["## Lens reviewer", "LENS-DB-LOCKED", "LENS-DB-CHECKLIST"]) {
      expect(text).toContain(needle);
    }
    expect(text).not.toContain("name: lens-db");
  });

  it("appends per-host prompt overrides only on that host (§12.3)", () => {
    expect(codex("vtc-engineer-frontend")).toContain("CODEX-ONLY-NOTE");
    expect(claude("vtc-engineer-frontend")).not.toContain("CODEX-ONLY-NOTE");
  });

  it("uses each host's model settings", () => {
    const toml = parseToml(file(output, "codex", "agents/vtc-engineer.toml"));
    expect(toml.model_reasoning_effort).toBe("high");
    expect(toml.features).toEqual({ request_permissions_tool: false });
    expect(file(output, "claude-code", "agents/vtc-engineer.md")).toContain("effort: medium");
  });
});

describe("compilePlugins: manifest", () => {
  const output = compileOk();

  it("lists every agent with its role, mode and prompt hash", () => {
    const m = manifest(output, "claude-code");
    expect(m.v).toBe(1);
    expect(m.host).toBe("claude-code");
    expect(m.agents.map((a) => a.name)).toEqual([
      "vtc-engineer",
      "vtc-engineer-frontend",
      "vtc-lens-db",
      "vtc-qa-author",
      "vtc-qa-judge",
    ]);
    const author = m.agents.find((a) => a.name === "vtc-qa-author");
    expect(author).toMatchObject({
      role: "qa",
      mode: "author",
      kind: "core",
      discipline: null,
      role_version: "2.1.0",
      file: "agents/vtc-qa-author.md",
      tier: "mid",
      effort: "medium",
    });
    const instructions = body(file(output, "claude-code", "agents/vtc-qa-author.md"));
    expect(author?.prompt_sha256).toBe(createHash("sha256").update(instructions).digest("hex"));
    expect(author?.prompt_sha256).toBe(promptShaFor(instructions));
    const codexInstructions = parseToml(file(output, "codex", "agents/vtc-qa-author.toml"))
      .developer_instructions as string;
    expect(manifest(output, "codex").agents.find((a) => a.name === "vtc-qa-author")).toMatchObject({
      prompt_sha256: promptShaFor(codexInstructions),
    });
    expect(m.agents.find((a) => a.name === "vtc-engineer-frontend")?.discipline).toBe("frontend");
  });

  it("classifies skills: stack and domain packs, lenses, the Lead skill and commands", () => {
    expect(manifest(output, "codex").skills).toEqual([
      {
        name: "domain-desktop",
        kind: "domain_pack",
        pack: "desktop",
        file: "skills/domain-desktop/SKILL.md",
      },
      { name: "lead", kind: "plugin", pack: null, file: "skills/lead/SKILL.md" },
      { name: "lens-db", kind: "lens", pack: "db", file: "skills/lens-db/SKILL.md" },
      {
        name: "stack-react-next",
        kind: "stack_pack",
        pack: "react-next",
        file: "skills/stack-react-next/SKILL.md",
      },
      { name: "vtc", kind: "command", pack: null, file: "skills/vtc/SKILL.md" },
    ]);
  });
});

describe("compilePlugins: role contracts asset (ROLE_CONTRACTS_ASSET, AD-14 rule 6)", () => {
  const output = compileOk();
  const contracts = (host: HostId): unknown[] =>
    JSON.parse(file(output, host, ROLE_CONTRACTS_ASSET)) as unknown[];

  it("is written at the shared asset path in both plugins", () => {
    expect(ROLE_CONTRACTS_ASSET).toBe("vtc/role-contracts.json");
    for (const host of ["claude-code", "codex"] as const) {
      expect(Array.isArray(contracts(host))).toBe(true);
    }
  });

  it("holds every role's contract, sorted by id, each valid against RoleContractSchema", () => {
    const loaded = loadRoles(fixtureFiles());
    if (!loaded.ok) throw new Error("fixture roles do not load");
    const parsed = contracts("claude-code").map((c) => RoleContractSchema.parse(c));
    expect(parsed.map((c) => c.id)).toEqual(["engineer", "engineer_frontend", "lens_db", "qa"]);
    expect(parsed).toEqual(
      [...loaded.roles.map((r) => r.role)].sort((a, b) => (a.id < b.id ? -1 : 1)),
    );
  });

  it("is the same file on both hosts", () => {
    expect(file(output, "codex", ROLE_CONTRACTS_ASSET)).toBe(
      file(output, "claude-code", ROLE_CONTRACTS_ASSET),
    );
  });

  it("keeps mode overrides and defaults, so the engine needs no second copy", () => {
    const qa = RoleContractSchema.parse(
      contracts("codex").find((c) => (c as { id?: string }).id === "qa"),
    );
    expect(qa.modes?.author?.tools?.write_paths).toEqual(["tests/acceptance/**"]);
    expect(qa.budget.return_tokens).toBeGreaterThan(0);
    expect(qa.tools.engine_tools).toEqual([]);
  });
});

describe("compilePlugins: hooks (spine §5 reading 31, the frozen `vtc hook` contract)", () => {
  const output = compileOk();
  type HookEntry = {
    matcher?: string;
    hooks: { type: string; command: string; timeout: number }[];
  };
  const hooks = (host: HostId): Record<string, HookEntry[]> =>
    (JSON.parse(file(output, host, HOOKS_FILE)) as { hooks: Record<string, HookEntry[]> }).hooks;
  const commandOf = (event: VtcHookEvent, host: HostId): string => {
    const c = vtcHookCommand(event, host);
    return [c.command, ...c.args].join(" ");
  };

  it.each(["claude-code", "codex"] as const)(
    "wires the three host events of %s to vtcHookCommand with the contract's timeout",
    (host) => {
      const wired = hooks(host);
      expect(Object.keys(wired).sort()).toEqual(["PreToolUse", "SessionStart", "SubagentStop"]);
      const events: [string, VtcHookEvent][] = [
        ["SessionStart", "session-start"],
        ["PreToolUse", "pre-tool-use"],
        ["SubagentStop", "subagent-stop"],
      ];
      for (const [hostEvent, event] of events) {
        const entries = wired[hostEvent] ?? [];
        expect(entries).toHaveLength(1);
        expect(entries[0]?.hooks).toEqual([
          { type: "command", command: commandOf(event, host), timeout: VTC_HOOK.timeoutMs / 1000 },
        ]);
      }
    },
  );

  it("limits the Claude Code pre-tool-use hook to shell and file-writing tools", () => {
    expect(hooks("claude-code").PreToolUse?.[0]?.matcher).toBe(
      "Bash|Write|Edit|MultiEdit|NotebookEdit",
    );
  });

  it("names the hook command with the host it runs on", () => {
    expect(file(output, "claude-code", HOOKS_FILE)).toContain(
      "vtc hook pre-tool-use --host claude-code",
    );
    expect(file(output, "codex", HOOKS_FILE)).toContain("vtc hook subagent-stop --host codex");
  });
});

describe("compilePlugins: errors", () => {
  it("fails on an AD-9 marker in any source, with file and line", () => {
    const marker = ["--dangerously", "skip-permissions"].join("-");
    expect(
      errorsOf({
        "skills/domain-desktop/SKILL.md": `---\nname: domain-desktop\ndescription: d\n---\nok\n${marker}\n`,
      }),
    ).toContain("skills/domain-desktop/SKILL.md: line 6: AD-9 marker");
  });

  it("fails when the Claude Code .mcp.json drifts from engineMcpServer", () => {
    expect(
      errorsOf({
        "plugins/claude-code/.mcp.json":
          '{ "mcpServers": { "vtc": { "command": "vtc", "args": [] } } }',
      }),
    ).toContain("plugins/claude-code/.mcp.json: must register the engine as");
  });

  it("validates skill frontmatter", () => {
    expect(
      errorsOf({
        "skills/stack-react-next/SKILL.md": "---\nname: react\ndescription: x\n---\nb\n",
      }),
    ).toContain("skills/stack-react-next/SKILL.md: frontmatter name must be stack-react-next");
    expect(
      errorsOf({ "skills/stack-react-next/SKILL.md": "---\nname: stack-react-next\n---\nb\n" }),
    ).toContain("skills/stack-react-next/SKILL.md: frontmatter needs a description");
    expect(errorsOf({ "skills/stack-react-next/SKILL.md": "no frontmatter\n" })).toContain(
      "skills/stack-react-next/SKILL.md: missing YAML frontmatter",
    );
  });

  it("requires the Engineer base for engineer profiles and the lens skill for lens roles", () => {
    expect(
      errorsOf({ "roles/engineer/role.yaml": null, "roles/engineer/prompt.md": null }),
    ).toContain(
      "roles/engineer_frontend: engineer profiles build on roles/engineer, which is missing",
    );
    expect(errorsOf({ "skills/lens-db/SKILL.md": null })).toContain(
      "roles/lens_db: lens roles need the skill skills/lens-db",
    );
  });

  it("rejects stray files, missing prompts and name collisions", () => {
    expect(errorsOf({ "roles/qa/notes.md": "x" })).toContain(
      "roles/qa/notes.md: unexpected file in a role directory",
    );
    expect(errorsOf({ "roles/qa/prompt.md": null })).toContain("roles/qa: missing prompt.md");
    expect(
      errorsOf({ "skills/vtc/SKILL.md": "---\nname: vtc\ndescription: clash\n---\nb\n" }),
    ).toContain("plugins/common/commands/vtc.md: command vtc collides with a skill of that name");
  });

  it("rejects a hand-written plugin file that shadows a generated one", () => {
    expect(
      errorsOf({ "plugins/claude-code/agents/vtc-qa-judge.md": "---\nname: x\n---\n" }),
    ).toContain("claude-code:agents/vtc-qa-judge.md: emitted twice");
    expect(errorsOf({ "plugins/codex/vtc-manifest.json": "{}" })).toContain(
      "codex:vtc-manifest.json: emitted twice",
    );
    expect(errorsOf({ "plugins/codex/vtc/role-contracts.json": "[]" })).toContain(
      "codex:vtc/role-contracts.json: emitted twice",
    );
  });

  it("rejects hand-written hooks (they are generated from vtcHookCommand) and unknown host files", () => {
    expect(errorsOf({ "plugins/claude-code/hooks/hooks.json": '{ "hooks": {} }' })).toContain(
      "plugins/claude-code/hooks/hooks.json: hooks are generated from vtcHookCommand; do not hand-write them",
    );
    expect(errorsOf({ "plugins/codex/hooks/hooks.json": '{ "hooks": {} }' })).toContain(
      "plugins/codex/hooks/hooks.json: hooks are generated from vtcHookCommand; do not hand-write them",
    );
    expect(errorsOf({ "plugins/codex/settings.json": "{}" })).toContain(
      "plugins/codex/settings.json: unexpected host plugin file",
    );
    expect(errorsOf({ "plugins/codex/.mcp.json": "{}" })).toContain(
      "plugins/codex/.mcp.json: the Codex MCP entry is generated from engineMcpServer",
    );
  });

  it.each([
    "plugins/codex/../../outside.json",
    "plugins/codex/./plugin.json",
    "plugins/codex//plugin.json",
    "/plugins/codex/plugin.json",
    "plugins\\codex\\x.json",
    "skills/stack-react-next/../../../x.md",
  ])("rejects the unclean source path %j", (path) => {
    expect(errorsOf({ [path]: "{}" })).toContain(
      `${path}: source paths are relative POSIX paths without . or ..`,
    );
  });

  it("rejects engine tools outside the frozen role-facing surface (AD-4 rule 3)", () => {
    const qa = fixtureFiles().find((f) => f.path === "roles/qa/role.yaml")?.text ?? "";
    const withTools = (tools: string): string =>
      qa.replace(
        'tools: { profile: write_scoped, write_paths: ["tests/acceptance/**"] }',
        `tools: { profile: write_scoped, write_paths: ["tests/acceptance/**"], engine_tools: [${tools}] }`,
      );
    expect(errorsOf({ "roles/qa/role.yaml": withTools("repo_map") })).toContain(
      "roles/qa: engine tool repo_map is not a role-facing tool in @vtc/shared",
    );
    expect(errorsOf({ "roles/qa/role.yaml": withTools("start") })).toContain(
      "roles/qa: engine tool start drives the run; only the Lead may call it",
    );
  });

  it("rejects every human-only engine tool in role.yaml (D-an, reading 71)", () => {
    const qa = fixtureFiles().find((f) => f.path === "roles/qa/role.yaml")?.text ?? "";
    for (const tool of HUMAN_ONLY_TOOLS) {
      const errors = errorsOf({
        "roles/qa/role.yaml": qa.replace(
          'tools: { profile: write_scoped, write_paths: ["tests/acceptance/**"] }',
          `tools: { profile: write_scoped, write_paths: ["tests/acceptance/**"], engine_tools: [${tool}] }`,
        ),
      });
      expect(errors, tool).toContain(
        `roles/qa: engine tool ${tool} records a human decision; no role may call it`,
      );
    }
  });

  it("rejects a Codex model id in role.yaml until the spike names Codex models (D-h, reading 26)", () => {
    const engineer = fixtureFiles().find((f) => f.path === "roles/engineer/role.yaml")?.text ?? "";
    expect(
      errorsOf({
        "roles/engineer/role.yaml": engineer.replace(
          "codex: { tier: mid, effort: high }",
          "codex: { tier: mid, effort: high, model: gpt-x }",
        ),
      }),
    ).toContain("roles/engineer: models.codex.model: Codex agents set only reasoning effort");
    const qa = fixtureFiles().find((f) => f.path === "roles/qa/role.yaml")?.text ?? "";
    expect(
      errorsOf({
        "roles/qa/role.yaml": qa.replace(
          "  judge:\n",
          "  judge:\n    models:\n      claude-code: { tier: low, effort: low }\n      codex: { tier: low, effort: low, model: gpt-y }\n",
        ),
      }),
    ).toContain("roles/qa: modes.judge.models.codex.model: Codex agents set only reasoning effort");
  });

  it("collects every error instead of stopping at the first", () => {
    const result = compilePlugins(
      fixtureFiles({ "roles/qa/notes.md": "x", "skills/lens-db/SKILL.md": "nope\n" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("checkEmitted: the gate on emitted trees (AD-16 rule 2)", () => {
  const marker = AD9_FORBIDDEN_MARKERS[0];

  it("reports an AD-9 marker that appears only in an emitted file, with host, path and line", () => {
    const emitted = [
      { path: "agents/vtc-qa-judge.toml", text: `name = "vtc-qa-judge"\nx = "${marker}"\n` },
      { path: "vtc-manifest.json", text: "{}\n" },
    ];
    expect(checkEmitted("codex", emitted)).toEqual([
      {
        path: "codex:agents/vtc-qa-judge.toml",
        message: `line 2: AD-9 marker ${marker} in emitted file`,
      },
    ]);
  });

  it("reports a path emitted twice and passes a clean tree", () => {
    const twice = [
      { path: "NOTICE", text: "a\n" },
      { path: "NOTICE", text: "b\n" },
    ];
    expect(checkEmitted("claude-code", twice)).toEqual([
      { path: "claude-code:NOTICE", message: "emitted twice" },
    ]);
    expect(checkEmitted("claude-code", compileOk().targets["claude-code"])).toEqual([]);
  });

  it("rejects two emitted paths that differ only in case", () => {
    const result = compilePlugins(
      fixtureFiles({
        "skills/stack-react-next/references/Notes.md": "upper\n",
        "skills/stack-react-next/references/notes.md": "lower\n",
      }),
    );
    expect(result.ok).toBe(false);
    const messages = result.ok ? [] : result.errors.map((e) => `${e.path}: ${e.message}`);
    for (const host of ["claude-code", "codex"]) {
      expect(messages).toContain(
        `${host}:skills/stack-react-next/references/notes.md: differs from skills/stack-react-next/references/Notes.md only in case; a case-insensitive file system keeps one`,
      );
    }
  });
});
