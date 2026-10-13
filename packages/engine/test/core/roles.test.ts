/**
 * One source for role contracts (AD-14 rule 6, AD-8 rule 9): the daemon loads the contracts
 * compiled from `roles/` out of its plugin assets (`ROLE_CONTRACTS_ASSET`) and nothing else; a
 * missing, broken or incomplete set is refused. The plugin manifest (`vtc-manifest.json`) gives
 * prompt SHAs and maps disciplines and stack packs to agents and skills. The test fixture
 * contracts must equal `roles/<role>/role.yaml` once those exist.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentNameFor,
  PLUGIN_MANIFEST_ASSET,
  promptShaFor,
  ROLE_CONTRACTS_ASSET,
  RoleContractSchema,
  type AssetBundle,
  type AssetNamespace,
  type PluginManifestInput,
} from "@vtc/shared";
import {
  compiledRoleContracts,
  createRoleRegistry,
  REQUIRED_ROLES,
  RoleContractsError,
} from "../../src/core/roles.js";
import { pluginCatalogFrom, pluginManifest, PluginManifestError } from "../../src/core/plugins.js";
import { parseYaml } from "../../src/core/yaml.js";
import { ALL_FIXTURE_ROLES, FIXTURE_ROLES } from "../fixtures/roles.js";

const bundle = (files: Partial<Record<AssetNamespace, Record<string, string>>>): AssetBundle => ({
  read: (namespace, path) => {
    const text = files[namespace]?.[path];
    return text === undefined ? undefined : new TextEncoder().encode(text);
  },
  list: (namespace) => Object.keys(files[namespace] ?? {}).sort(),
});

describe("compiled role contracts (AD-14 rule 6)", () => {
  it("are loaded from the plugin assets, the only source", () => {
    const compiled = FIXTURE_ROLES.map((r) =>
      r.id === "repo_cartographer"
        ? { ...r, tools: { profile: "write_scoped", write_paths: [".vtc/research/map/**"] } }
        : r,
    );
    const contracts = compiledRoleContracts(
      bundle({ "plugin:claude-code": { [ROLE_CONTRACTS_ASSET]: JSON.stringify(compiled) } }),
    );
    const registry = createRoleRegistry(contracts);
    expect(registry.get("repo_cartographer")?.tools.write_paths).toEqual([".vtc/research/map/**"]);
  });
  it("refuse a bundle without them: there is no built-in fallback", () => {
    expect(() => compiledRoleContracts(bundle({}))).toThrow(/no plugin in the asset bundle/);
    expect(createRoleRegistry([]).get("ba")).toBeUndefined();
  });
  it("refuse a broken, duplicated or incomplete set", () => {
    const broken = bundle({ "plugin:codex": { [ROLE_CONTRACTS_ASSET]: "[{" } });
    expect(() => compiledRoleContracts(broken)).toThrow(RoleContractsError);
    const invalid = bundle({
      "plugin:claude-code": { [ROLE_CONTRACTS_ASSET]: JSON.stringify([{ id: "ba" }]) },
    });
    expect(() => compiledRoleContracts(invalid)).toThrow(RoleContractsError);
    const partial = bundle({
      "plugin:claude-code": {
        [ROLE_CONTRACTS_ASSET]: JSON.stringify(FIXTURE_ROLES.filter((r) => r.id !== "engineer")),
      },
    });
    expect(() => compiledRoleContracts(partial)).toThrow(/no contract for engineer/);
    const twice = bundle({
      "plugin:claude-code": {
        [ROLE_CONTRACTS_ASSET]: JSON.stringify([...FIXTURE_ROLES, FIXTURE_ROLES[0]]),
      },
    });
    expect(() => compiledRoleContracts(twice)).toThrow(/listed twice/);
  });
  it("cover every role the engine dispatches, advisors included in the fixture", () => {
    for (const id of REQUIRED_ROLES) expect(FIXTURE_ROLES.some((r) => r.id === id)).toBe(true);
    expect(ALL_FIXTURE_ROLES.filter((r) => r.kind === "advisor").map((r) => r.id)).toEqual([
      "client_liaison",
      "cost_analyst",
    ]);
  });
});

const manifest = (over: Partial<PluginManifestInput> = {}): PluginManifestInput => ({
  v: 1,
  host: "claude-code",
  plugin: "vtc",
  contracts_version: "4.1.0",
  agents: [
    {
      name: agentNameFor("ba"),
      role: "ba",
      mode: null,
      kind: "core",
      discipline: null,
      role_version: "1.0.0",
      file: "agents/vtc-ba.md",
      prompt_sha256: promptShaFor("You are the BA."),
      tier: "top",
      effort: "high",
    },
    {
      name: agentNameFor("engineer_frontend"),
      role: "engineer_frontend",
      mode: null,
      kind: "engineer_profile",
      discipline: "frontend",
      role_version: "1.0.0",
      file: "agents/vtc-engineer-frontend.md",
      prompt_sha256: promptShaFor("You build UIs."),
      tier: "mid",
      effort: "medium",
    },
  ],
  skills: [
    { name: "react", kind: "stack_pack", pack: "react", file: "skills/react/SKILL.md" },
    { name: "lens-a11y", kind: "lens", pack: null, file: "skills/lens-a11y/SKILL.md" },
  ],
  ...over,
});

describe("the plugin manifest (vtc-manifest.json, AD-14, §13)", () => {
  it("gives each agent's prompt SHA, discipline profile and stack-pack skills", () => {
    const catalog = pluginCatalogFrom(
      bundle({
        "plugin:claude-code": {
          [PLUGIN_MANIFEST_ASSET]: JSON.stringify({ ...manifest(), extra_key: "newer minor" }),
        },
      }),
    );
    expect(catalog.promptSha("vtc-ba", "claude-code")).toBe(promptShaFor("You are the BA."));
    expect(catalog.profileFor("claude-code", "frontend")).toBe("vtc-engineer-frontend");
    expect(catalog.profileFor("claude-code", "backend")).toBeUndefined();
    expect(catalog.skillsFor("claude-code", ["react", "vue"])).toEqual(["react"]);
    // no manifest for codex: the SHA of the agent's file, else of its name
    expect(catalog.promptSha("vtc-ba", "codex")).toBe(promptShaFor("vtc-ba"));
  });
  it("refuses a broken manifest or one for the other host", () => {
    const broken = bundle({ "plugin:codex": { [PLUGIN_MANIFEST_ASSET]: "{" } });
    expect(() => pluginManifest(broken, "codex")).toThrow(PluginManifestError);
    const other = bundle({
      "plugin:codex": { [PLUGIN_MANIFEST_ASSET]: JSON.stringify(manifest()) },
    });
    expect(() => pluginManifest(other, "codex")).toThrow(/describes the claude-code plugin/);
    expect(pluginManifest(bundle({}), "codex")).toBeNull();
  });
});

const ROLES_DIR = fileURLToPath(new URL("../../../../roles/", import.meta.url));
const roleSources = existsSync(ROLES_DIR)
  ? readdirSync(ROLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(`${ROLES_DIR}${d.name}/role.yaml`))
      .map((d) => d.name)
  : [];

describe("the fixture contracts and roles/ cannot drift (AD-14)", () => {
  it("every fixture contract is valid and has a unique id", () => {
    for (const role of ALL_FIXTURE_ROLES) expect(RoleContractSchema.parse(role)).toEqual(role);
    expect(new Set(ALL_FIXTURE_ROLES.map((r) => r.id)).size).toBe(ALL_FIXTURE_ROLES.length);
  });
  // roles/ is populated in sub-project 3; from then on this compares every source.
  it.skipIf(roleSources.length === 0)("each roles/<role>/role.yaml equals the fixture", () => {
    for (const id of roleSources) {
      const source = RoleContractSchema.parse(
        parseYaml(readFileSync(`${ROLES_DIR}${id}/role.yaml`, "utf8")),
      );
      const fixture = ALL_FIXTURE_ROLES.find((r) => r.id === source.id);
      if (fixture === undefined) continue; // roles the engine does not dispatch by id
      expect({ ...fixture, mission: source.mission, version: source.version }).toEqual(source);
    }
  });
});
