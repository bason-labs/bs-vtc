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
  DOMAIN_PACKS,
  ENGINE_MCP_TOOLS,
  engineMcpServer,
  HOST_IDS,
  VerdictQuestionTypeSchema,
  type RoleContract,
} from "@vtc/shared";
import {
  checkPluginFiles,
  claudeEngineToolName,
  compiledAgentNames,
  compilePlugins,
  KNOWN_ARTIFACT_TYPES,
  loadRoles,
  readSources,
  ROLE_FACING_ENGINE_TOOLS,
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

  it.each(HOST_IDS)("the %s plugin registers the engine bridge", (host) => {
    const mcp = output().targets[host].find((f) => f.path === ".mcp.json");
    const entry = engineMcpServer(host);
    expect(JSON.parse(mcp?.text ?? "{}")).toEqual({
      mcpServers: { [entry.name]: { command: entry.command, args: entry.args } },
    });
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
      expect(["read-only", "workspace-write"]).toContain(toml.sandbox_mode);
    }
  });
});

/** Frontmatter and body of an emitted Claude Code agent file. */
const claudeAgent = (text: string): { tools: string[]; body: string } => {
  const match = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  const front = parseYaml(match?.[1] ?? "") as { tools?: string };
  return { tools: (front.tools ?? "").split(", "), body: match?.[2] ?? "" };
};

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

  it("keeps the engine bridge off, or limited to role-facing tools, in every Codex role agent", () => {
    const entry = engineMcpServer("codex");
    for (const f of output().targets.codex.filter((t) => t.path.startsWith("agents/"))) {
      const server = (parseToml(f.text).mcp_servers as Record<string, Record<string, unknown>>)[
        entry.name
      ];
      if (server?.enabled === false) continue;
      const enabled = (server?.enabled_tools ?? ["(all)"]) as string[];
      expect(
        enabled.filter((t) => !ROLE_FACING_ENGINE_TOOLS.includes(t)),
        f.path,
      ).toEqual([]);
    }
  });

  it("never tells an agent without a shell to run tests or commands", () => {
    const noShell = claudeAgents().filter((a) => !a.tools.includes("Bash"));
    expect(noShell.length).toBeGreaterThan(0);
    for (const agent of noShell) {
      expect(RUN_INSTRUCTION.exec(agent.body)?.[0], agent.path).toBeUndefined();
    }
  });
});

describe("the v1 roster (§5.2, §5.2a, §5.3)", () => {
  it("has a role source for every Tier-1 role; the Lead is the plugin's Lead skill", () => {
    for (const id of CORE_ROLES.filter((r) => r !== "lead")) expect(role(id)?.kind).toBe("core");
    expect(role("lead")).toBeUndefined();
    expect(sources.map((s) => s.path)).toContain("plugins/common/skills/lead/SKILL.md");
  });

  it("has one engineer profile per core discipline", () => {
    const profiles = roles.filter((r) => r.kind === "engineer_profile");
    expect(profiles.map((r) => r.discipline).sort()).toEqual([...CORE_DISCIPLINES].sort());
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
    expect(used.filter((t) => !KNOWN_ARTIFACT_TYPES.includes(t))).toEqual([]);
  });
});

describe("the advisors (§5.4: Tier 3; compiled, held out of the Lead loop for now)", () => {
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

  it("has a read-only advisor role for every §5.4 advisor and no other", () => {
    expect(
      roles
        .filter((r) => r.kind === "advisor")
        .map((r) => r.id)
        .sort(),
    ).toEqual(ADVISORS);
    for (const id of ADVISORS) expect(role(id)?.tools.profile).toBe("read_only");
  });

  it("keeps advisors out of the Lead loop until the engine has an action for them (AD-4 rule 1)", () => {
    const command = sources.find((s) => s.path === "plugins/common/commands/vtc.md")?.text ?? "";
    expect(lead()).not.toMatch(/^## Advisors/m);
    expect(lead()).not.toMatch(/`vtc-advisor-[a-z-]+`/);
    expect(command).not.toMatch(/advise/);
    const never = /## Never\n([\s\S]*?)\n\n/.exec(lead())?.[1] ?? "";
    expect(never).toMatch(/Spawn an agent `next` did not return/);
    expect(never).toMatch(/`vtc-advisor-\*`/);
  });

  it("tells the Lead to spawn the agent exactly as the engine names it (AD-14 rule 1)", () => {
    expect(lead()).toMatch(/spelled exactly as given/);
    expect(lead()).not.toMatch(/`vtc:/);
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

  it("classifies every role as forked or written for VTC", () => {
    expect(roles.map((r) => r.id).sort()).toEqual([...FORKED, ...WRITTEN].sort());
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
