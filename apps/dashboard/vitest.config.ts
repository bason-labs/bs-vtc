import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.ts";

/** Component and unit tests run in jsdom; `@/` maps to `src/` like the Next.js build. */
export default mergeConfig(
  sharedConfig,
  defineConfig({
    resolve: {
      alias: { "@/": fileURLToPath(new URL("./src/", import.meta.url)) },
    },
    oxc: { jsx: { runtime: "automatic" } },
    test: {
      name: "dashboard",
      environment: "jsdom",
      include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
      setupFiles: ["./test/setup.ts"],
    },
  }),
);
