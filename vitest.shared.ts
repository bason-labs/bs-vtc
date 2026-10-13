import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Base Vitest config shared by every package (see AD-11 in docs/architecture/vtc-spine.md).
 * Workspace packages resolve to their TypeScript sources so tests never depend on a prior build.
 */
export const sharedConfig = defineConfig({
  resolve: {
    alias: {
      "@vtc/shared": pkg("shared"),
      "@vtc/engine": pkg("engine"),
      "@vtc/adapters": pkg("adapters"),
      "@vtc/compiler": pkg("compiler"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
    passWithNoTests: false,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
    },
  },
});
