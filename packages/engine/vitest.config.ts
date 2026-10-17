import { defineConfig, mergeConfig } from "vitest/config";
import { sharedConfig, testWorkers } from "../../vitest.shared.ts";

/** D-cz (reading 249): the long pole of `pnpm test`, so it keeps the whole machine's workers. */
export default mergeConfig(
  sharedConfig,
  defineConfig({ test: { name: "engine", maxWorkers: testWorkers(1) } }),
);
