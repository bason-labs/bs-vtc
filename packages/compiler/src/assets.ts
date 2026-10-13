/**
 * The compiled plugins as `AssetBundle` entries (AD-2 rule 7, AD-16 rule 2, AD-20): namespace
 * `plugin:<host>` holds the target tree. The cli builds the real bundle (from `dist/` in
 * development, from Bun-embedded files in the binary); this in-memory form serves tests and
 * any caller that compiles at run time.
 */
import type { AssetBundle, AssetNamespace, HostId } from "@vtc/shared";
import type { CompileOutput } from "./types.js";

export interface AssetEntry {
  readonly namespace: AssetNamespace;
  readonly path: string;
  readonly bytes: Uint8Array;
}

export const pluginNamespace = (host: HostId): AssetNamespace => `plugin:${host}`;

export const assetEntries = (output: CompileOutput): AssetEntry[] => {
  const encoder = new TextEncoder();
  return (Object.keys(output.targets) as HostId[]).flatMap((host) =>
    output.targets[host].map((file) => ({
      namespace: pluginNamespace(host),
      path: file.path,
      bytes: encoder.encode(file.text),
    })),
  );
};

export const createMemoryAssetBundle = (entries: readonly AssetEntry[]): AssetBundle => {
  const byNamespace = new Map<AssetNamespace, Map<string, Uint8Array>>();
  for (const entry of entries) {
    const files = byNamespace.get(entry.namespace) ?? new Map<string, Uint8Array>();
    files.set(entry.path, entry.bytes);
    byNamespace.set(entry.namespace, files);
  }
  return {
    read: (namespace, path) => byNamespace.get(namespace)?.get(path),
    list: (namespace) => [...(byNamespace.get(namespace)?.keys() ?? [])].sort(),
  };
};
