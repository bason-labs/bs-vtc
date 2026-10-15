/**
 * How this `vtc` runs: from the product repo in development (Node, assets read from disk), or as
 * the single-file binary (Bun, assets embedded; AD-2, AD-20). The entry point configures it once
 * (`bin.ts` for Node, `binary/main.ts` for the binary) before `main` runs.
 */
import { readFileSync } from "node:fs";
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
  /**
   * The lockfile this `vtc` was built from (D-bv (4), spine §5 reading 216): the product repo's
   * `pnpm-lock.yaml` in development, the copy embedded in the binary; `undefined` when there is
   * none. The daemon's daily scan of VTC's own dependencies reads it.
   */
  vtcLockfile(): Uint8Array | undefined;
}

/** A file's bytes, or `undefined` when it cannot be read. */
const readOptional = (path: string | undefined): Uint8Array | undefined => {
  if (path === undefined) return undefined;
  try {
    return new Uint8Array(readFileSync(path));
  } catch {
    return undefined;
  }
};

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
  vtcLockfile: () => readOptional(join(root, "pnpm-lock.yaml")),
});

/** `lockfile`: the embedded path of the lockfile the binary was built from. */
export const binaryRuntime = (
  assets: AssetBundle,
  executable: string,
  lockfile?: string,
): CliRuntime => ({
  kind: "binary",
  assets,
  selfCommand: [executable],
  vtcLockfile: () => readOptional(lockfile),
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
