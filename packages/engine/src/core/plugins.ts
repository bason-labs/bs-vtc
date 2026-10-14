/**
 * What the compiled host plugins hold, from their `vtc-manifest.json` (`PLUGIN_MANIFEST_ASSET`,
 * read with `parsePersisted(PluginManifestSchema)`): the prompt SHA of each agent (§13,
 * `role.dispatched.prompt_sha`), the discipline profile for a task's discipline (§5.2a) and the
 * skills that serve its stack packs (§5.3). A plugin built without a manifest (development) falls
 * back to a SHA of the agent's file, or of its name.
 */
import {
  HOST_IDS,
  parsePersisted,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  rolePromptAssetPath,
  type AssetBundle,
  type HostId,
  type PluginManifest,
} from "@vtc/shared";

export interface PluginCatalog {
  /** The prompt SHA of the compiled agent `agent` on `host` (§13). */
  promptSha(agent: string, host: HostId): string;
  /** The discipline profile agent for a task's discipline (§5.2a), if the plugin has one. */
  profileFor(host: HostId, discipline: string): string | undefined;
  /** The skills that serve the packs a task names (§5.3), by name. */
  skillsFor(host: HostId, packs: readonly string[]): string[];
  /**
   * The agent's prompt parts from its manifest entry (AD-21, spine §5 readings 117–118): the SHA
   * of its locked core and whether it expects the editable section as the pack's `Role
   * heuristics` block; `undefined` when the plugin has no manifest entry for it. Optional: a
   * catalog without it runs every agent's compiled prompt.
   */
  promptParts?(agent: string, host: HostId): PromptParts | undefined;
}

/** What {@link PluginCatalog.promptParts} returns. */
export interface PromptParts {
  readonly lockedSha256?: string;
  readonly editableInPack: boolean;
  /**
   * The agent's locked core and compiled default editable section as the plugin carries them
   * (`rolePromptAssetPath`), when the bundle has both. For an agent with `editableInPack` the
   * engine renders the default section in the pack when no pin applies (spine §5 reading 142);
   * for a headless run on a host that cannot load the compiled agent (`codex exec`), the engine
   * carries both itself (spine §5 reading 145).
   */
  readonly compiled?: { readonly locked: string; readonly editable: string };
}

export class PluginManifestError extends Error {
  constructor(host: HostId, detail: string) {
    super(`the ${host} plugin's ${PLUGIN_MANIFEST_ASSET} is unusable: ${detail}`);
    this.name = "PluginManifestError";
  }
}

/** The manifest of a host's plugin, `null` when the bundle carries none. Throws when broken. */
export const pluginManifest = (assets: AssetBundle, host: HostId): PluginManifest | null => {
  const bytes = assets.read(`plugin:${host}`, PLUGIN_MANIFEST_ASSET);
  if (bytes === undefined) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(bytes).toString("utf8"));
  } catch (error) {
    throw new PluginManifestError(host, error instanceof Error ? error.message : String(error));
  }
  const parsed = parsePersisted(PluginManifestSchema, raw);
  if (!parsed.success)
    throw new PluginManifestError(
      host,
      parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; "),
    );
  if (parsed.data.host !== host)
    throw new PluginManifestError(host, `it describes the ${parsed.data.host} plugin`);
  return parsed.data;
};

/** The SHA of the agent's file in the plugin namespace, or of its name (no manifest). */
const fileSha =
  (assets: AssetBundle | null) =>
  (agent: string, host: HostId): string => {
    const namespace = `plugin:${host}` as const;
    const file = assets
      ?.list(namespace)
      .find((p) => p.split("/").at(-1)?.startsWith(`${agent}.`) === true);
    const bytes = file === undefined ? undefined : assets?.read(namespace, file);
    return promptShaFor(bytes === undefined ? agent : Buffer.from(bytes).toString("utf8"));
  };

/** The locked and default editable texts the plugin carries for an agent, when it has both. */
const compiledParts = (
  assets: AssetBundle | null,
  host: HostId,
  agent: string,
): { locked: string; editable: string } | undefined => {
  if (assets === null) return undefined;
  const text = (part: "locked" | "editable"): string | undefined => {
    let path: string;
    try {
      path = rolePromptAssetPath(agent, part);
    } catch {
      return undefined;
    }
    const bytes = assets.read(`plugin:${host}`, path);
    return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
  };
  const locked = text("locked");
  const editable = text("editable");
  return locked === undefined || editable === undefined ? undefined : { locked, editable };
};

/** A catalog over the given manifests (per host; missing ones fall back, see the module doc). */
export const createPluginCatalog = (
  manifests: Readonly<Partial<Record<HostId, PluginManifest | null>>>,
  assets: AssetBundle | null = null,
): PluginCatalog => {
  const fallback = fileSha(assets);
  return {
    promptSha: (agent, host) =>
      manifests[host]?.agents.find((a) => a.name === agent)?.prompt_sha256 ?? fallback(agent, host),
    profileFor: (host, discipline) =>
      manifests[host]?.agents.find(
        (a) => a.kind === "engineer_profile" && a.discipline === discipline,
      )?.name,
    skillsFor: (host, packs) =>
      (manifests[host]?.skills ?? [])
        .filter((s) => s.pack !== null && packs.includes(s.pack))
        .map((s) => s.name),
    promptParts: (agent, host) => {
      const entry = manifests[host]?.agents.find((a) => a.name === agent);
      if (entry === undefined) return undefined;
      const editableInPack = entry.editable_in_pack === true;
      const compiled = compiledParts(assets, host, agent);
      return {
        ...(entry.locked_sha256 === undefined ? {} : { lockedSha256: entry.locked_sha256 }),
        editableInPack,
        ...(compiled === undefined ? {} : { compiled }),
      };
    },
  };
};

/** The catalog of the plugins an asset bundle carries (the daemon's). */
export const pluginCatalogFrom = (assets: AssetBundle): PluginCatalog =>
  createPluginCatalog(
    Object.fromEntries(HOST_IDS.map((host) => [host, pluginManifest(assets, host)])),
    assets,
  );
