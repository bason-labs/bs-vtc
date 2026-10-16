import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * D-cz (spine §5 reading 249): a package's share of the machine's test workers. turbo runs every
 * package's tests at once, and each vitest sizing its pool to the whole machine (its default,
 * cpus - 1) put about 70 workers on 11 cores, where a pure-CPU test timed out. Each package takes
 * a quarter, and the engine, whose suite runs several times longer than all the others, takes the
 * whole machine (`packages/engine/vitest.config.ts`): once the short suites finish it runs alone.
 */
export const testWorkers = (share: number): number =>
  Math.max(1, Math.floor((availableParallelism() - 1) * share));

const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * Base Vitest config shared by every package (see AD-11 in docs/architecture/vtc-spine.md).
 * Workspace packages resolve to their TypeScript sources so tests never depend on a prior build.
 */
export const sharedConfig = defineConfig({
  resolve: {
    // More specific keys first: Vite matches `@vtc/engine` as a prefix of `@vtc/engine/...`.
    alias: {
      "@vtc/engine/test-support": fileURLToPath(
        new URL("./packages/engine/test/storage-contract.ts", import.meta.url),
      ),
      "@vtc/shared": pkg("shared"),
      "@vtc/engine": pkg("engine"),
      "@vtc/adapters": pkg("adapters"),
      "@vtc/compiler": pkg("compiler"),
    },
  },
  test: {
    environment: "node",
    // D-cz (readings 246, 249): a quarter of the machine's workers, and each run's own temp root
    maxWorkers: testWorkers(0.25),
    globalSetup: [fileURLToPath(new URL("./vitest.tmpdir.ts", import.meta.url))],
    // a test behaves as in a Lead session even when an engine-launched headless role run (VTC
    // building VTC) runs it: `HEADLESS_ROLE_ENV` (@vtc/shared hook contract rule 7) is cleared
    env: { VTC_HEADLESS_ROLE: "" },
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
