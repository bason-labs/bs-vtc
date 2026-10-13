/**
 * The `vtc` entry inside the single-file binary (§4.4, AD-2, AD-20). The binary build
 * (`scripts/build-binary.ts`) generates a module that embeds the dashboard export and the
 * compiled plugins as Bun files and calls {@link runBinary} with their embedded paths.
 */
import { createEmbeddedAssetBundle, type EmbeddedAssetFiles } from "../assets.js";
import { runProcess } from "../index.js";
import { binaryRuntime, configureRuntime } from "../runtime.js";

export const runBinary = (files: EmbeddedAssetFiles): void => {
  configureRuntime(binaryRuntime(createEmbeddedAssetBundle(files), process.execPath));
  void runProcess(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
};
