/**
 * Compiles the real role, skill and plugin sources of this repo (AD-14, AD-16 Check) and checks
 * the v1 roster against the spec (§5.2, §5.2a, §5.3, §5.5).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  CORE_DISCIPLINES,
  CORE_ROLES,
  DESIGN_SCREENS_PATH,
  DesignScreenSchema,
  DesignScreensFileSchema,
  DOMAIN_PACKS,
  ENGINE_MCP_TOOLS,
  EffortSchema,
  engineMcpServer,
  HOST_IDS,
  HUMAN_ONLY_TOOLS,
  isKnownArtifactType,
  PrototypeThemeSchema,
  prototypeStatePath,
  ROLE_CONTRACTS_ASSET,
  RoleContractSchema,
  VerdictQuestionTypeSchema,
  type RoleContract,
} from "@vtc/shared";
import {
  ADVISOR_QUESTION_ARTIFACT,
  AGENT_PLUGINS_SCHEMAS,
  CODEX_MCP_FILE,
  checkPluginFiles,
  CLAUDE_DENIED_TOOLS,
  claudeEngineToolName,
  compiledAgentNames,
  compilePlugins,
  HOOKS_FILE,
  loadRoles,
  PLUGIN_NAME,
  PROPOSED_ARTIFACT_TYPES,
  readSources,
  ROLE_FACING_ENGINE_TOOLS,
  SCAFFOLD_HEADER,
  type CompileOutput,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = readSources(ROOT);
const sources = read.files;
const compiled = compilePlugins(sources);

const output = (): CompileOutput => {
  if (!compiled.ok) {
    throw new Error(compiled.errors.map((e) => `${e.path}: ${e.message}`).join("\n"));
  }
  return compiled.output;
};

const loaded = loadRoles(sources);
const roles: RoleContract[] = loaded.ok ? loaded.roles.map((r) => r.role) : [];
const role = (id: string): RoleContract | undefined => roles.find((r) => r.id === id);
const promptOf = (id: string): string => readFileSync(`${ROOT}roles/${id}/prompt.md`, "utf8");

describe("the repo's sources compile (AD-16 Check)", () => {
  it("compiles without errors", () => {
    expect(read.errors).toEqual([]);
    expect(compiled.ok ? [] : compiled.errors).toEqual([]);
    expect(loaded.ok ? [] : loaded.errors).toEqual([]);
  });

  it("the claude-code plugin registers the engine bridge in .mcp.json", () => {
    const mcp = output().targets["claude-code"].find((f) => f.path === ".mcp.json");
    const entry = engineMcpServer("claude-code");
    expect(JSON.parse(mcp?.text ?? "{}")).toEqual({
      mcpServers: { [entry.name]: { command: entry.command, args: entry.args } },
    });
  });

  it("the codex plugin registers the engine bridge in the portable mcp.json, with its transport", () => {
    const mcp = output().targets.codex.find((f) => f.path === CODEX_MCP_FILE);
    const entry = engineMcpServer("codex");
    expect(JSON.parse(mcp?.text ?? "{}")).toEqual({
      $schema: AGENT_PLUGINS_SCHEMAS.mcp,
      mcpServers: { [entry.name]: { type: "stdio", command: entry.command, args: entry.args } },
    });
    const manifest = JSON.parse(
      sources.find((f) => f.path === "plugins/codex/plugin.json")?.text ?? "{}",
    ) as Record<string, unknown>;
    expect(manifest.$schema).toBe(AGENT_PLUGINS_SCHEMAS.plugin);
  });

  it.each(HOST_IDS)("the %s plugin has exactly one agent per compiled agent name", (host) => {
    const ext = host === "codex" ? ".toml" : ".md";
    const emitted = output()
      .targets[host].filter((f) => f.path.startsWith("agents/"))
      .map((f) => f.path.slice("agents/".length, -ext.length))
      .sort();
    expect(emitted).toEqual(roles.flatMap(compiledAgentNames).sort());
  });

  it.each(HOST_IDS)("the %s plugin passes the AD-9 gate", (host) => {
    expect(checkPluginFiles(output().targets[host])).toEqual([]);
  });

  it("every Codex agent is valid TOML with instructions", () => {
    for (const f of output().targets.codex.filter((t) => t.path.endsWith(".toml"))) {
      const toml = parseToml(f.text);
      expect(typeof toml.developer_instructions).toBe("string");
      expect(toml.sandbox_mode).toBeUndefined();
    }
  });
});

/** Frontmatter and body of an emitted Claude Code agent file. */
const claudeAgent = (text: string): { tools: string[]; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  const front = parseYaml(match?.[1] ?? "") as { tools?: string };
  return { tools: (front.tools ?? "").split(", "), body: match?.[2] ?? "" };
};

const claudeAgentBody = (text: string): string => claudeAgent(text).body;

/** An instruction to run something, which an agent without a shell cannot follow. */
const RUN_INSTRUCTION =
  /\b(run|execute)\s+((the|your|each|every|all|a|an|new|visible|hidden)\s+)*(tests?|commands?|scripts?|suites?|shell|builds?|linters?)\b/i;

describe("role agents get only what their contract allows (AD-4, AD-8 rule 3)", () => {
  const claudeAgents = (): { path: string; tools: string[]; body: string }[] =>
    output()
      .targets["claude-code"].filter((f) => f.path.startsWith("agents/"))
      .map((f) => ({ path: f.path, ...claudeAgent(f.text) }));

  it("names only role-facing engine tools in role.yaml", () => {
    const named = roles.flatMap((r) => [
      ...r.tools.engine_tools,
      ...Object.values(r.modes ?? {}).flatMap((m) => m.tools?.engine_tools ?? []),
    ]);
    expect(named.filter((t) => !ROLE_FACING_ENGINE_TOOLS.includes(t))).toEqual([]);
  });

  it("never gives a Claude Code role agent a tool that drives the run", () => {
    const lead = ENGINE_MCP_TOOLS.map((t) => claudeEngineToolName(t.name));
    for (const agent of claudeAgents()) {
      expect(
        agent.tools.filter((t) => lead.includes(t)),
        agent.path,
      ).toEqual([]);
    }
  });

  it("never gives any role agent a human-only engine tool, on either host (D-an, reading 71)", () => {
    const agents = claudeAgents();
    expect(agents.length).toBe(roles.flatMap(compiledAgentNames).length);
    const human = HUMAN_ONLY_TOOLS.flatMap((t) => [t, claudeEngineToolName(t)]);
    for (const agent of agents) {
      expect(
        agent.tools.filter((t) => human.includes(t)),
        agent.path,
      ).toEqual([]);
    }
    // a Codex agent inherits the session's bridge (reading 82): it names no engine tool at all,
    // and the engine refuses human-only and Lead-only calls from role sessions (reading 71)
    const codex = output().targets.codex.filter((t) => t.path.startsWith("agents/"));
    expect(codex.length).toBe(roles.flatMap(compiledAgentNames).length);
    for (const f of codex) expect(parseToml(f.text).mcp_servers, f.path).toBeUndefined();
  });

  it("never tells an agent without a shell to run tests or commands", () => {
    const noShell = claudeAgents().filter((a) => !a.tools.includes("Bash"));
    expect(noShell.length).toBeGreaterThan(0);
    for (const agent of noShell) {
      expect(RUN_INSTRUCTION.exec(agent.body)?.[0], agent.path).toBeUndefined();
    }
  });
});

describe("no role touches VTC's own guard rails (D-w, spine §5 reading 43)", () => {
  const agentFiles = (host: "claude-code" | "codex") =>
    output().targets[host].filter((f) => f.path.startsWith("agents/"));

  it("every Claude Code agent names only bare tools in disallowedTools (reading 81)", () => {
    // a specifier there removes the whole tool; the path and command rules are permissions.deny
    const files = agentFiles("claude-code");
    expect(files.length).toBe(roles.flatMap(compiledAgentNames).length);
    for (const f of files) {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(f.text);
      const front = parseYaml(match?.[1] ?? "") as { disallowedTools?: string; tools?: string };
      const denied = (front.disallowedTools ?? "").split(", ");
      expect(denied, f.path).toEqual(CLAUDE_DENIED_TOOLS);
      expect(
        denied.filter((t) => /[()]/.test(t)),
        f.path,
      ).toEqual([]);
      expect((front.tools ?? "").split(", "), f.path).toContain("Read");
    }
  });

  it("every Codex agent sets no sandbox key it cannot set, and turns off what it may (reading 82)", () => {
    // a Codex custom agent file cannot override sandbox_mode, approval_policy or mcp_servers; the
    // only per-agent reductions are features.* = false and skills.*
    const files = agentFiles("codex");
    expect(files.length).toBe(roles.flatMap(compiledAgentNames).length);
    for (const f of files) {
      const toml = parseToml(f.text);
      expect(f.text, f.path).not.toMatch(
        /sandbox_mode|sandbox_workspace_write|mcp_servers|approval_policy/,
      );
      expect((toml.features as Record<string, unknown>).request_permissions_tool, f.path).toBe(
        false,
      );
    }
  });
});

describe("host identity of the compiled agents (D-aa, D-ae; spine §5 readings 26, 47, 51)", () => {
  const pluginJson = (path: string): { name?: string } =>
    JSON.parse(sources.find((s) => s.path === path)?.text ?? "{}") as { name?: string };

  it("keeps the plugin name `vtc` on both hosts, so headless Claude runs resolve `--agent vtc:<agent>`", () => {
    expect(PLUGIN_NAME).toBe("vtc");
    expect(pluginJson("plugins/claude-code/.claude-plugin/plugin.json").name).toBe(PLUGIN_NAME);
    expect(pluginJson("plugins/codex/plugin.json").name).toBe(PLUGIN_NAME);
  });

  it("names every Claude Code agent by its bare compiled name; the host adds the `vtc:` namespace", () => {
    for (const f of output().targets["claude-code"].filter((t) => t.path.startsWith("agents/"))) {
      const match = /^---\n([\s\S]*?)\n---\n/.exec(f.text);
      const front = parseYaml(match?.[1] ?? "") as { name?: string };
      expect(`agents/${String(front.name)}.md`).toBe(f.path);
      expect(front.name, f.path).not.toContain(":");
    }
  });

  it("sets only the reasoning effort on every Codex agent, never a model id (D-ae)", () => {
    for (const f of output().targets.codex.filter((t) => t.path.startsWith("agents/"))) {
      const toml = parseToml(f.text);
      expect(toml.model, f.path).toBeUndefined();
      expect(EffortSchema.options, f.path).toContain(toml.model_reasoning_effort);
    }
  });

  it("emits Codex agents only as top-level Codex config keys, ready for the headless identity spike", () => {
    // headless `codex exec` has no --agent flag (spine §7): whichever way the spike loads a role
    // (agent file, profile or config overrides), each key here is a plain Codex config key
    const keys = new Set([
      "name",
      "description",
      "model_reasoning_effort",
      "developer_instructions",
      "features",
    ]);
    for (const f of output().targets.codex.filter((t) => t.path.startsWith("agents/"))) {
      expect(
        Object.keys(parseToml(f.text)).filter((k) => !keys.has(k)),
        f.path,
      ).toEqual([]);
    }
  });
});

describe("the v1 roster (§5.2, §5.2a, §5.3)", () => {
  it("has a role source for every Tier-1 role; the Lead is the plugin's Lead skill", () => {
    for (const id of CORE_ROLES.filter((r) => r !== "lead")) expect(role(id)?.kind).toBe("core");
    expect(role("lead")).toBeUndefined();
    expect(sources.map((s) => s.path)).toContain("plugins/common/skills/lead/SKILL.md");
  });

  it("has one engineer profile per core discipline, and one discipline per profile", () => {
    const profiles = roles.filter((r) => r.kind === "engineer_profile");
    const disciplines = profiles.map((r) => r.discipline);
    for (const d of CORE_DISCIPLINES) expect(disciplines, d).toContain(d);
    expect(new Set(disciplines).size).toBe(disciplines.length);
    for (const p of profiles) expect(p.id).toBe(`engineer_${String(p.discipline)}`);
  });

  it("has a domain pack skill for every domain pack", () => {
    const paths = sources.map((s) => s.path);
    for (const pack of DOMAIN_PACKS) {
      expect(paths).toContain(`skills/domain-${pack.replaceAll("_", "-")}/SKILL.md`);
    }
  });

  it("has the stack packs named in §5.2a", () => {
    const paths = sources.map((s) => s.path);
    const packs = [
      "react-next",
      "vue-nuxt",
      "angular",
      "svelte",
      "node-nest",
      "django",
      "fastapi",
      "go",
      "spring",
      "laravel",
      "dotnet",
      "rails",
      "swiftui",
      "compose",
      "postgres",
      "mysql",
      "mongodb",
      "terraform",
      "kubernetes",
      "aws",
      "gcp",
      "azure",
    ];
    for (const pack of packs) expect(paths).toContain(`skills/stack-${pack}/SKILL.md`);
  });

  it("has a lens skill for every §5.3 specialist and a reviewer role for each risk-rule lens", () => {
    const paths = sources.map((s) => s.path);
    const lenses = [
      "db",
      "auth",
      "payments",
      "privacy",
      "secrets",
      "infra",
      "api",
      "a11y",
      "i18n",
      "performance",
      "llm",
      "supply-chain",
      "docs",
      "compliance",
      "mobile",
    ];
    for (const lens of lenses) expect(paths).toContain(`skills/lens-${lens}/SKILL.md`);
    const reviewerLenses = ["db", "auth", "payments", "secrets", "infra", "api", "supply_chain"];
    for (const lens of reviewerLenses) expect(role(`lens_${lens}`)?.kind).toBe("lens");
  });

  it("gives each Visual QA criterion V1 to V8 a question type from the contract", () => {
    const rows = [...promptOf("visual_qa").matchAll(/^\| (V\d) +\|.*\| ([a-z_]+) +\|$/gm)];
    expect(rows.map((r) => r[1])).toEqual(["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8"]);
    for (const row of rows) expect(VerdictQuestionTypeSchema.options).toContain(row[2]);
  });

  it("declares the QA and Security modes (AD-14 rule 1)", () => {
    expect(Object.keys(role("qa")?.modes ?? {})).toEqual(["author", "judge"]);
    expect(Object.keys(role("security")?.modes ?? {})).toEqual(["design", "verify"]);
  });

  it("wires the pairs that may never self-review (§5.5)", () => {
    expect(role("ba")?.reviewer).toBe("spec_verifier");
    expect(role("engineer")?.reviewer).toBe("qa");
    expect(role("designer")?.reviewer).toBe("visual_qa");
    for (const p of roles.filter((r) => r.kind === "engineer_profile"))
      expect(p.reviewer).toBe("qa");
  });

  it("gives only the Engineer family a code sandbox (§5.2: the only role that writes code)", () => {
    const sandboxed = roles.filter((r) => r.tools.profile === "code_sandboxed").map((r) => r.id);
    expect(sandboxed.every((id) => id === "engineer" || id.startsWith("engineer_"))).toBe(true);
  });

  it("lets only the Planner submit tasks and only QA author submit acceptance tests", () => {
    for (const r of roles) {
      const outputs = [r.output, ...Object.values(r.modes ?? {}).map((m) => m.output)];
      const artifacts = outputs.flatMap((o) => o?.artifacts ?? []);
      if (artifacts.includes("tasks")) expect(r.id).toBe("planner");
      if (artifacts.includes("acceptance_test")) expect(r.id).toBe("qa");
    }
    expect(role("planner")?.output.artifacts).toContain("tasks");
    expect(role("qa")?.modes?.author?.output?.artifacts).toContain("acceptance_test");
  });

  it("uses only known artifact types, so a typo cannot silently disconnect a port", () => {
    const used = roles.flatMap((r) => [
      ...r.inputs,
      ...r.output.artifacts,
      ...Object.values(r.modes ?? {}).flatMap((m) => [
        ...(m.inputs ?? []),
        ...(m.output?.artifacts ?? []),
      ]),
    ]);
    const proposed: readonly string[] = PROPOSED_ARTIFACT_TYPES;
    expect(used.filter((t) => !isKnownArtifactType(t) && !proposed.includes(t))).toEqual([]);
  });

  it("has no type still proposed to @vtc/shared: the advisor question is a known type now", () => {
    expect(PROPOSED_ARTIFACT_TYPES).toEqual([]);
    expect(isKnownArtifactType(ADVISOR_QUESTION_ARTIFACT)).toBe(true);
  });
});

describe("the compiled role contracts the engine loads (ROLE_CONTRACTS_ASSET)", () => {
  it.each(HOST_IDS)("the %s plugin carries every role's validated contract", (host) => {
    const asset = output().targets[host].find((f) => f.path === ROLE_CONTRACTS_ASSET);
    const contracts = (JSON.parse(asset?.text ?? "[]") as unknown[]).map((c) =>
      RoleContractSchema.parse(c),
    );
    expect(contracts.map((c) => c.id)).toEqual(roles.map((r) => r.id).sort());
    for (const id of CORE_ROLES.filter((r) => r !== "lead")) {
      expect(contracts.map((c) => c.id)).toContain(id);
    }
  });

  it.each(HOST_IDS)("the %s plugin wires its hooks to `vtc hook`", (host) => {
    const hooks = output().targets[host].find((f) => f.path === HOOKS_FILE)?.text ?? "";
    for (const event of ["session-start", "pre-tool-use", "subagent-stop"]) {
      expect(hooks).toContain(`vtc hook ${event} --host ${host}`);
    }
  });

  it("documents that the hooks run the `vtc` binary from PATH and what happens without it", () => {
    const readme = readFileSync(`${ROOT}plugins/README.md`, "utf8");
    const hooks = /^- `hooks\/hooks\.json`:[\s\S]*?(?=\n\n)/m.exec(readme)?.[0] ?? "";
    expect(hooks).toMatch(/`vtc` binary on `PATH`/);
    expect(hooks).toMatch(/hook error/);
    expect(hooks).toMatch(/spine §7/);
  });
});

describe("spine §5 readings 27, 29 and 37 (write scopes of the research and design roles)", () => {
  it("keeps the Repo Cartographer and the Research Analyst inside their research directories", () => {
    expect(role("repo_cartographer")?.tools).toMatchObject({
      profile: "write_scoped",
      write_paths: [".vtc/research/repo-map/**"],
    });
    expect(role("research_analyst")?.tools).toMatchObject({
      profile: "write_scoped",
      write_paths: [".vtc/research/briefs/**"],
    });
  });

  it("keeps QA at author and judge, with the SPECIFY testability pass in author mode", () => {
    expect(Object.keys(role("qa")?.modes ?? {})).toEqual(["author", "judge"]);
    const author = /<!-- vtc:mode author -->([\s\S]*?)<!-- vtc:mode-end -->/.exec(
      promptOf("qa"),
    )?.[1];
    expect(author).toMatch(/### Testability pass/);
  });

  it("writes the threat model only from Security design mode", () => {
    expect(role("security")?.modes?.design?.tools).toMatchObject({
      profile: "write_scoped",
      write_paths: [".vtc/architecture/threat-model/**"],
    });
    expect(role("security")?.modes?.verify?.tools?.profile).toBe("read_only");
  });

  it("only the Architect and the Research Analyst declare the research tools (AD-22)", () => {
    // roles/README.md: they declare `engine_tools` together with the engine's fixture contracts
    // (the wave-3 merge)
    const declaring = roles.filter(
      (r) =>
        r.tools.engine_tools.length > 0 ||
        Object.values(r.modes ?? {}).some((m) => (m.tools?.engine_tools ?? []).length > 0),
    );
    expect(declaring.map((r) => r.id).sort()).toEqual(["architect", "research_analyst"]);
  });
});

describe("the Planner names exact config and task-runner paths (D-x, D-y; readings 44, 45, 63)", () => {
  const locked = (): string =>
    (promptOf("planner").split("<!-- vtc:editable -->")[0] ?? "").replace(/\s+/g, " ");

  it("tells the Planner, in the locked core, to list each config or task-runner file by exact path", () => {
    const text = locked();
    expect(text).toContain("scaffolds or changes a lint, test or scanner config");
    for (const file of ["`Makefile`", "`justfile`", "`*.mk`", "`package.json` `scripts`"]) {
      expect(text, file).toContain(file);
    }
    expect(text).toMatch(/`files_scope` must name that exact path/);
    expect(text).toContain("`packages/foo/tsconfig.json`");
    expect(text).toMatch(/no wildcard/);
  });

  it("tells the Planner write-scope globs have no alternatives or rule-breaking characters", () => {
    const text = locked();
    expect(text).toContain("`{a,b}`");
    for (const word of ["commas", "parentheses", "quotes", "backticks", "whitespace"]) {
      expect(text, word).toContain(word);
    }
    expect(text).toMatch(/each alternative as its own entry/);
  });
});

describe("prompts read the engine's dispatch settings from the pack (spine §5 reading 32)", () => {
  const compiledBody = (name: string): string =>
    claudeAgentBody(
      output().targets["claude-code"].find((f) => f.path === `agents/${name}.md`)?.text ?? "",
    );

  it.each([
    ["vtc-architect", "architect depth"],
    ["vtc-research-analyst", "research depth"],
    ["vtc-designer", "design constraints"],
  ])("%s reads the `%s` line of the Dispatch section", (name, line) => {
    const text = compiledBody(name);
    expect(text).toContain(`\`${line}\``);
    expect(text).toMatch(/Dispatch section/);
  });

  it("has the Designer write the screen list in the shared DesignScreensFile shape", () => {
    const text = compiledBody("vtc-designer");
    expect(text).toContain(DESIGN_SCREENS_PATH);
    for (const key of [
      ...Object.keys(DesignScreensFileSchema.shape),
      ...Object.keys(DesignScreenSchema.shape),
    ]) {
      expect(text).toContain(`\`${key}\``);
    }
    expect(text).toContain(prototypeStatePath("/invoices", "empty", "dark"));
    expect(text).toContain(PrototypeThemeSchema.options.join(", "));
  });

  it("adds no task-scoped gap clarification to the BA or the Designer (D-b, reading 19)", () => {
    for (const id of ["ba", "designer"]) {
      expect(promptOf(id), id).not.toMatch(/spec_gap|design_gap/);
    }
  });
});

describe("the advisors (§5.4: Tier 3; called through the engine's consult, spine §5 reading 25)", () => {
  /** Estimator / Solution Architect, Client-liaison writer, UX Researcher, Incident debugger,
   * Legacy explainer, ML/Data advisor. */
  const ADVISORS = [
    "advisor_client_liaison",
    "advisor_estimator",
    "advisor_incident_debugger",
    "advisor_legacy_explainer",
    "advisor_ml_data",
    "advisor_ux_researcher",
  ];
  const lead = (): string =>
    sources.find((s) => s.path === "plugins/common/skills/lead/SKILL.md")?.text ?? "";

  it("has an advisor role for every §5.4 advisor and no other, reviewed by the human", () => {
    expect(
      roles
        .filter((r) => r.kind === "advisor")
        .map((r) => r.id)
        .sort(),
    ).toEqual(ADVISORS);
    for (const id of ADVISORS) expect(role(id)?.reviewer).toBe("human");
  });

  it("keeps every advisor read-only except the client liaison's export (reading 30)", () => {
    for (const id of ADVISORS.filter((a) => a !== "advisor_client_liaison")) {
      expect(role(id)?.tools.profile, id).toBe("read_only");
    }
    expect(role("advisor_client_liaison")?.tools).toMatchObject({
      profile: "write_scoped",
      write_paths: [".vtc/exports/**"],
    });
    expect(role("advisor_client_liaison")?.output.artifacts).toEqual(["client_export"]);
  });

  it("has the Lead call advisors only through consult, and submit their results (AD-4 rule 1)", () => {
    const command = sources.find((s) => s.path === "plugins/common/commands/vtc.md")?.text ?? "";
    const advisors = /^## Advisors\n([\s\S]*?)\n## /m.exec(lead())?.[1] ?? "";
    expect(advisors).toContain("`consult`");
    expect(advisors).toContain("`submit`");
    for (const id of ADVISORS) expect(advisors).toContain(`\`${id}\``);
    expect(advisors).not.toMatch(/`vtc[:-]advisor/);
    expect(/^## Engine tools\n\n([\s\S]*?)\n\n/m.exec(lead())?.[1]).toContain("`consult`");
    expect(command).toMatch(/advise "<question>"/);
    const never = /## Never\n([\s\S]*?)\n\n/.exec(lead())?.[1] ?? "";
    expect(never).toMatch(/Spawn an agent that neither `next` nor `consult` returned/);
  });

  it("gives every advisor the human's question as advisor_question, apart from the run's request", () => {
    for (const id of ADVISORS) expect(role(id)?.inputs[0], id).toBe(ADVISOR_QUESTION_ARTIFACT);
    const protocol = readFileSync(`${ROOT}roles/_shared/advisor-protocol.md`, "utf8");
    expect(protocol.replace(/\s+/g, " ")).toContain(
      `is the \`${ADVISOR_QUESTION_ARTIFACT}\` input`,
    );
    expect(protocol).toMatch(/`request`[^.]*the run's idea or change request/);
    expect(protocol).not.toMatch(/question[^.]*is the `request` input/);
    expect(promptOf("advisor_estimator")).not.toMatch(
      /^- The request or change request to estimate/m,
    );
    const readme = readFileSync(`${ROOT}roles/README.md`, "utf8");
    expect(readme).not.toMatch(/question is its `request` input/);
    expect(readme).toMatch(/`advisor_question`[\s\S]*provisional/);
  });

  it("drops the outside-the-engine reading from the READMEs", () => {
    for (const path of ["roles/README.md", "plugins/README.md"]) {
      const text = readFileSync(`${ROOT}${path}`, "utf8");
      expect(text, path).not.toMatch(/held out of the Lead|outside the run|not yet called/i);
    }
  });

  it("tells the Lead to spawn the agent the engine names, or its host-namespaced listing (AD-14 rule 1)", () => {
    const loop = (/^## The loop\n([\s\S]*?)\n## /m.exec(lead())?.[1] ?? "").replace(/\s+/g, " ");
    expect(loop).toContain("Spell `agent` as given.");
    expect(loop).toContain("never a different agent");
    // until the plugin-agent-name spike settles, the skill does not promise a host-ready name
    expect(loop).not.toMatch(/already names it the way this host expects/);
  });

  it("tells the Lead to pass the model and report the session and full failure outcomes (AD-4)", () => {
    const loop = (/^## The loop\n([\s\S]*?)\n## /m.exec(lead())?.[1] ?? "").replace(/\s+/g, " ");
    expect(loop).toMatch(/When `spawn_role` carries `model`, pass it to the spawn/);
    // D-ae: no model on the action means the session's model; never invent one
    expect(loop).toMatch(/When it has no `model`, pass none/);
    expect(loop).toMatch(
      /`submit` with `kind` `result`, the `action_id`, the `result`, `session_ref`/,
    );
    for (const field of ["resets_at", "window", "message", "retryable", "tokens", "cost_usd"])
      expect(loop, field).toContain(`\`${field}\``);
  });
});

describe("role prompts are contracts, not personas (principles 2 and 6)", () => {
  const ids = roles.map((r) => r.id);

  it.each(ids)("%s has no persona, memory or vibe section", (id) => {
    expect(promptOf(id)).not.toMatch(/^#+ .*(identity|memory|personality|vibe|backstory)/im);
    expect(promptOf(id)).not.toMatch(/\bYou are (\*\*|an? (expert|senior|specialist|seasoned))/i);
  });

  it.each(ids)("%s uses no emoji", (id) => {
    expect(promptOf(id)).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it.each(ids)("%s names no agent and no run-state path", (id) => {
    expect(promptOf(id)).not.toMatch(/vtc-[a-z]/);
    expect(promptOf(id)).not.toContain(".vtc/");
  });
});

describe("every run agent's prompt has the §5.1 parts", () => {
  /** The §5.1 parts each run agent's assembled instructions must carry, by heading or line. */
  const PARTS: readonly [string, RegExp][] = [
    ["inputs", /^- Inputs \(/m],
    ["procedure", /^#{2,3} .*[Pp]rocedure$/m],
    ["output contract", /^## Contract$/m],
    ["definition of done", /^#{2,3} Definition of done$/m],
    ["never-do list", /^#{2,3} Never\b/m],
    ["exits, each with when to use it", /^- Exits: .+\n {2}- `[a-z_]+`: /m],
    ["a canonical example", /^#{2,3} Example$/m],
  ];
  const runAgents = (): { path: string; body: string }[] =>
    output()
      .targets["claude-code"].filter(
        (f) => f.path.startsWith("agents/") && !f.path.startsWith("agents/vtc-advisor-"),
      )
      .map((f) => ({ path: f.path, body: claudeAgent(f.text).body }));

  it("covers every run agent", () => {
    const advisors = roles.filter((r) => r.kind === "advisor").flatMap(compiledAgentNames);
    expect(runAgents().length).toBe(roles.flatMap(compiledAgentNames).length - advisors.length);
  });

  it.each(PARTS)("every run agent has %s", (_part, pattern) => {
    for (const agent of runAgents()) expect(agent.body, agent.path).toMatch(pattern);
  });
});

describe("attribution (spec §5.1: the MIT notice is kept)", () => {
  it("keeps the agency-agents copyright and permission notice", () => {
    const notice = readFileSync(`${ROOT}roles/NOTICE`, "utf8");
    expect(notice).toContain("msitarzewski/agency-agents");
    expect(notice).toContain("Copyright (c) 2025 AgentLand Contributors");
    expect(notice).toContain("Permission is hereby granted, free of charge");
  });

  /** Roles the catalogue (§7.1, §7.2) forks from an upstream base. */
  const FORKED = [
    "advisor_incident_debugger",
    "advisor_legacy_explainer",
    "advisor_ml_data",
    "advisor_ux_researcher",
    "architect",
    "ba",
    "designer",
    "engineer",
    "engineer_ai_llm",
    "engineer_backend",
    "engineer_data",
    "engineer_devops",
    "engineer_frontend",
    "engineer_mobile",
    "lens_api",
    "lens_auth",
    "lens_db",
    "lens_infra",
    "lens_payments",
    "lens_secrets",
    "planner",
    "qa",
    "repo_cartographer",
    "research_analyst",
    "security",
    "visual_qa",
  ];
  /** Roles the catalogue says to write new, with upstream material merged in. */
  const WRITTEN = [
    "advisor_client_liaison",
    "advisor_estimator",
    "lens_supply_chain",
    "lookback",
    "spec_verifier",
  ];
  const roleYaml = (id: string): string => readFileSync(`${ROOT}roles/${id}/role.yaml`, "utf8");

  /** Roles the new-role scaffold wrote (D-cd): their role.yaml opens with its header. */
  const scaffolded = (): string[] =>
    roles.map((r) => r.id).filter((id) => roleYaml(id).split("\n")[0] === SCAFFOLD_HEADER);

  it("classifies every role as forked, written for VTC, or written by the new-role scaffold", () => {
    expect(roles.map((r) => r.id).sort()).toEqual([...FORKED, ...WRITTEN, ...scaffolded()].sort());
  });

  it.each(FORKED)("%s names its upstream base in a '# Forked from' line", (id) => {
    expect(roleYaml(id)).toMatch(/^# Forked from msitarzewski\/agency-agents \(MIT/m);
  });

  it.each(WRITTEN)("%s says it was written for VTC and names what it merged in", (id) => {
    expect(roleYaml(id)).toMatch(/^# Written for VTC/m);
    expect(roleYaml(id)).toContain("msitarzewski/agency-agents");
  });

  it("names the sources of every lens and domain pack and of the Lead skill", () => {
    const skills = sources.filter((f) =>
      /^(skills\/(lens|domain)-[^/]+|plugins\/common\/skills\/lead)\/SKILL\.md$/.test(f.path),
    );
    expect(skills.length).toBe(15 + DOMAIN_PACKS.length + 1);
    for (const skill of skills) {
      expect(skill.text, skill.path).toMatch(/^Sources: .*(agency-agents|written for VTC)/m);
    }
  });
});
