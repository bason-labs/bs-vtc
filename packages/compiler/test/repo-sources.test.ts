/**
 * Compiles the real role, skill and plugin sources of this repo (AD-14, AD-16 Check) and checks
 * the v1 roster against the spec (§5.2, §5.2a, §5.3, §5.5).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  CORE_DISCIPLINES,
  CORE_ROLES,
  DOMAIN_PACKS,
  engineMcpServer,
  HOST_IDS,
  type RoleContract,
} from "@vtc/shared";
import {
  checkPluginFiles,
  compiledAgentNames,
  compilePlugins,
  KNOWN_ARTIFACT_TYPES,
  loadRoles,
  readSources,
  type CompileOutput,
} from "../src/index.js";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const sources = readSources(ROOT);
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

describe("attribution (spec §5.1: the MIT notice is kept)", () => {
  it("keeps the agency-agents copyright and permission notice", () => {
    const notice = readFileSync(`${ROOT}roles/NOTICE`, "utf8");
    expect(notice).toContain("msitarzewski/agency-agents");
    expect(notice).toContain("Copyright (c) 2025 AgentLand Contributors");
    expect(notice).toContain("Permission is hereby granted, free of charge");
  });

  it("names its upstream sources in every forked role", () => {
    const forked = roles.filter((r) =>
      readFileSync(`${ROOT}roles/${r.id}/role.yaml`, "utf8").includes("# Forked from"),
    );
    expect(forked.length).toBeGreaterThanOrEqual(15);
  });
});
