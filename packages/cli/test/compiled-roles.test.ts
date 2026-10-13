/**
 * Integration (AD-14 rule 6, AD-1 rule 4): the cli is the one package that wires the compiler
 * and the engine together, so it proves that what the compiler emits from the real `roles/`,
 * `skills/` and `plugins/` sources is what the engine's daemon loads at startup. The engine's
 * own tests run on fixture contracts (kept equal to `roles/` by a drift test); this test runs the
 * real compile and the engine's real loaders on its output.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compilePlugins, readSources } from "@vtc/compiler";
import { core } from "@vtc/engine";
import {
  agentNameFor,
  CONTRACTS_VERSION,
  HOST_IDS,
  promptShaFor,
  type AssetBundle,
  type AssetNamespace,
  type HostId,
} from "@vtc/shared";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const compiled = (() => {
  const read = readSources(REPO_ROOT);
  const result = compilePlugins(read.files);
  if (read.errors.length > 0 || !result.ok)
    throw new Error(
      [...read.errors, ...(result.ok ? [] : result.errors)]
        .map((e) => `${e.path}: ${e.message}`)
        .join("\n"),
    );
  return result.output;
})();

/** The compiled plugin trees as the daemon's asset bundle sees them (`plugin:<host>`). */
const bundle = (hosts: readonly HostId[] = HOST_IDS): AssetBundle => {
  const files = new Map<AssetNamespace, Map<string, string>>(
    hosts.map((host) => [
      `plugin:${host}` as const,
      new Map(compiled.targets[host].map((f) => [f.path, f.text])),
    ]),
  );
  return {
    read: (namespace, path) => {
      const text = files.get(namespace)?.get(path);
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    list: (namespace) => [...(files.get(namespace)?.keys() ?? [])].sort(),
  };
};

describe("the compiled plugins load into the engine (AD-14 rule 6)", () => {
  it("each host's role-contracts.json covers every role the engine dispatches", () => {
    for (const host of HOST_IDS) {
      const contracts = core.compiledRoleContracts(bundle([host]));
      const registry = core.createRoleRegistry(contracts);
      for (const id of core.REQUIRED_ROLES) expect(registry.get(id)?.id).toBe(id);
      expect(contracts.filter((c) => c.kind === "advisor").length).toBeGreaterThan(0);
    }
  });

  it("each host's manifest names an agent for every role and mode the engine spawns", () => {
    const contracts = core.compiledRoleContracts(bundle());
    for (const host of HOST_IDS) {
      const manifest = core.pluginManifest(bundle(), host);
      expect(manifest?.contracts_version).toBe(CONTRACTS_VERSION);
      const names = new Set(manifest?.agents.map((a) => a.name));
      for (const contract of contracts) {
        const modes = Object.keys(contract.modes ?? {});
        for (const mode of modes.length > 0 ? modes : [undefined])
          expect(names, `${host}: ${contract.id}/${mode ?? "-"}`).toContain(
            agentNameFor(contract.id, mode),
          );
      }
      // the engine records the prompt SHA the manifest gives, not a stand-in (§13)
      const catalog = core.pluginCatalogFrom(bundle());
      const ba = manifest?.agents.find((a) => a.name === agentNameFor("ba"));
      expect(catalog.promptSha(agentNameFor("ba"), host)).toBe(ba?.prompt_sha256);
      expect(ba?.prompt_sha256).not.toBe(promptShaFor(agentNameFor("ba")));
    }
  });

  it("every discipline profile the manifest lists resolves through the catalog", () => {
    const catalog = core.pluginCatalogFrom(bundle());
    for (const host of HOST_IDS) {
      const profiles = core
        .pluginManifest(bundle(), host)
        ?.agents.filter((a) => a.discipline !== null);
      expect(profiles?.length).toBeGreaterThan(0);
      for (const p of profiles ?? [])
        expect(catalog.profileFor(host, p.discipline ?? "")).toBe(p.name);
    }
  });
});
