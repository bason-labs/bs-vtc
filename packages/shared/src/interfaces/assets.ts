/**
 * Embedded asset seam (AD-2 rule 7). The single binary embeds the dashboard's static export and
 * the compiled plugin templates (§4.4). Packages never import `apps/` or touch the binary's
 * embedding mechanism: the cli builds an {@link AssetBundle} (from disk in development, from
 * Bun-embedded files in the binary) and injects it.
 */

/** Asset namespaces: the dashboard export served by the engine, and one plugin per host. */
export type AssetNamespace = "dashboard" | "plugin:claude-code" | "plugin:codex";

export interface AssetBundle {
  /** Bytes of one asset by POSIX path relative to the namespace root, or `undefined`. */
  read(namespace: AssetNamespace, path: string): Uint8Array | undefined;
  /** Every asset path in a namespace, sorted. */
  list(namespace: AssetNamespace): readonly string[];
}
