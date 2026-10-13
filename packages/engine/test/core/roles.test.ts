/**
 * One source for role contracts (AD-14, AD-8 rule 9): the daemon loads the contracts compiled
 * from `roles/` out of its plugin assets; a broken or incomplete set is refused; the built-in
 * contracts the engine falls back to must equal `roles/<role>/role.yaml` once those exist.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RoleContractSchema, type AssetBundle, type AssetNamespace } from "@vtc/shared";
import {
  BUILTIN_ROLES,
  compiledRoleContracts,
  createRoleRegistry,
  ROLE_CONTRACTS_ASSET,
  RoleContractsError,
} from "../../src/core/roles.js";
import { parseYaml } from "../../src/core/yaml.js";

const bundle = (files: Partial<Record<AssetNamespace, Record<string, string>>>): AssetBundle => ({
  read: (namespace, path) => {
    const text = files[namespace]?.[path];
    return text === undefined ? undefined : new TextEncoder().encode(text);
  },
  list: (namespace) => Object.keys(files[namespace] ?? {}).sort(),
});

describe("compiled role contracts (AD-14)", () => {
  it("are loaded from the plugin assets and replace the built-ins", () => {
    const compiled = BUILTIN_ROLES.map((r) =>
      r.id === "repo_cartographer"
        ? { ...r, tools: { profile: "write_scoped", write_paths: [".vtc/research/map/**"] } }
        : r,
    );
    const contracts = compiledRoleContracts(
      bundle({ "plugin:claude-code": { [ROLE_CONTRACTS_ASSET]: JSON.stringify(compiled) } }),
    );
    expect(contracts).not.toBeNull();
    const registry = createRoleRegistry(contracts ?? []);
    expect(registry.get("repo_cartographer")?.tools.write_paths).toEqual([".vtc/research/map/**"]);
  });
  it("are absent from a bundle without them (the built-ins apply)", () => {
    expect(compiledRoleContracts(bundle({}))).toBeNull();
    expect(createRoleRegistry().get("ba")?.tools.write_paths).toEqual([".vtc/spec/**"]);
  });
  it("refuse a broken or incomplete set", () => {
    const broken = bundle({ "plugin:codex": { [ROLE_CONTRACTS_ASSET]: "[{" } });
    expect(() => compiledRoleContracts(broken)).toThrow(RoleContractsError);
    const invalid = bundle({
      "plugin:claude-code": { [ROLE_CONTRACTS_ASSET]: JSON.stringify([{ id: "ba" }]) },
    });
    expect(() => compiledRoleContracts(invalid)).toThrow(RoleContractsError);
    const partial = bundle({
      "plugin:claude-code": {
        [ROLE_CONTRACTS_ASSET]: JSON.stringify(BUILTIN_ROLES.filter((r) => r.id !== "engineer")),
      },
    });
    expect(() => compiledRoleContracts(partial)).toThrow(/no contract for engineer/);
  });
});

const ROLES_DIR = fileURLToPath(new URL("../../../../roles/", import.meta.url));
const roleSources = existsSync(ROLES_DIR)
  ? readdirSync(ROLES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(`${ROLES_DIR}${d.name}/role.yaml`))
      .map((d) => d.name)
  : [];

describe("the built-in contracts and roles/ cannot drift (AD-14)", () => {
  it("every built-in contract is valid and has a unique id", () => {
    for (const role of BUILTIN_ROLES) expect(RoleContractSchema.parse(role)).toEqual(role);
    expect(new Set(BUILTIN_ROLES.map((r) => r.id)).size).toBe(BUILTIN_ROLES.length);
  });
  // roles/ is populated in sub-project 3; from then on this compares every source.
  it.skipIf(roleSources.length === 0)("each roles/<role>/role.yaml equals the built-in", () => {
    for (const id of roleSources) {
      const source = RoleContractSchema.parse(
        parseYaml(readFileSync(`${ROLES_DIR}${id}/role.yaml`, "utf8")),
      );
      const builtin = BUILTIN_ROLES.find((r) => r.id === source.id);
      expect(builtin, `no built-in contract for ${source.id}`).toBeDefined();
      expect({ ...builtin, mission: source.mission, version: source.version }).toEqual(source);
    }
  });
});
