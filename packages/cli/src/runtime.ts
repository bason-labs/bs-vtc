/**
 * How this `vtc` runs: from the product repo in development (Node, assets read from disk), or as
 * the single-file binary (Bun, assets embedded; AD-2, AD-20). The entry point configures it once
 * (`bin.ts` for Node, `binary/main.ts` for the binary) before `main` runs.
 */
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSET_SOURCES, extractedPluginDir, type AssetBundle, type HostId } from "@vtc/shared";
import { createDiskAssetBundle, devAssetRoots, extractNamespace } from "./assets.js";
import { VERSION } from "./version.js";

export interface CliRuntime {
  readonly kind: "dev" | "binary";
  readonly assets: AssetBundle;
  /**
   * The argv prefix that runs this same `vtc` (the detached daemon, the launchd agent):
   * `[node, …/bin.js]` in development, `[<binary>]` in the binary.
   */
  readonly selfCommand: readonly string[];
  /**
   * The compiled plugin for `host` on disk, for `HostAdapter.install` (AD-6 rule 5): the
   * product repo's `dist/<host>-plugin` in development; in the binary, the embedded
   * `plugin:<host>` namespace extracted to `<vtcHome>/plugins/<version>/<host>` (AD-20 rule 5).
   */
  pluginDir(host: HostId, vtcHome: string): string;
}

/** The VTC product repo root when running from source or from `packages/cli/dist`. */
export const productRoot = (): string => fileURLToPath(new URL("../../../", import.meta.url));

export const devRuntime = (
  root: string = productRoot(),
  selfCommand: readonly string[] = [process.execPath, join(root, "packages/cli/dist/bin.js")],
): CliRuntime => ({
  kind: "dev",
  assets: createDiskAssetBundle(devAssetRoots(root)),
  selfCommand,
  pluginDir: (host) => join(root, ...ASSET_SOURCES[`plugin:${host}`].split("/")),
});

export const binaryRuntime = (assets: AssetBundle, executable: string): CliRuntime => ({
  kind: "binary",
  assets,
  selfCommand: [executable],
  pluginDir: (host, vtcHome) =>
    extractNamespace(
      assets,
      `plugin:${host}`,
      join(vtcHome, ...extractedPluginDir(VERSION, host).split("/")),
    ),
});

let current: CliRuntime | undefined;

export const configureRuntime = (runtime: CliRuntime): void => {
  current = runtime;
};

/** The configured runtime; development from the product repo when nothing configured one. */
export const runtime = (): CliRuntime => (current ??= devRuntime());
