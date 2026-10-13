/**
 * Reading the compiled plugin `install` places (AD-16 rule 4): its `vtc-manifest.json`
 * (`PLUGIN_MANIFEST_ASSET`), parsed tolerantly with `parsePersisted` (a plugin built by a newer
 * MINOR may carry keys this reader does not know), and checked against this host and version.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import {
  CONTRACTS_VERSION,
  contractsCompatible,
  parsePersisted,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  type HostId,
  type PluginManifest,
} from "@vtc/shared";

/** A path inside `root` from a manifest's relative path; refuses anything that escapes it. */
export const insidePlugin = (root: string, relative: string): string => {
  const base = resolve(root);
  const path = resolve(base, relative);
  if (!path.startsWith(base + sep)) {
    throw new Error(`plugin path ${relative} escapes the plugin directory`);
  }
  return path;
};

export const readPluginManifest = (pluginDir: string, host: HostId): PluginManifest => {
  const path = join(pluginDir, PLUGIN_MANIFEST_ASSET);
  if (!existsSync(path)) {
    throw new Error(
      `no compiled ${host} plugin at ${pluginDir} (missing ${PLUGIN_MANIFEST_ASSET})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = parsePersisted(PluginManifestSchema, raw);
  if (!parsed.success) {
    throw new Error(`${path} is not a valid plugin manifest: ${parsed.error.message}`);
  }
  const manifest = parsed.data;
  if (manifest.host !== host) {
    throw new Error(`${path} is a ${manifest.host} plugin, not a ${host} plugin`);
  }
  if (!contractsCompatible(manifest.contracts_version, CONTRACTS_VERSION)) {
    throw new Error(
      `the plugin was compiled against contracts ${manifest.contracts_version}, this vtc uses ${CONTRACTS_VERSION}; rebuild or reinstall vtc`,
    );
  }
  for (const agent of manifest.agents) {
    if (!existsSync(insidePlugin(pluginDir, agent.file))) {
      throw new Error(`the plugin manifest lists ${agent.file}, which is missing`);
    }
  }
  return manifest;
};
