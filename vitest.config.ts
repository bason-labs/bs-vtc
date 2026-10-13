import { defineConfig } from "vitest/config";

/** Root config: `pnpm vitest` from the repo root runs every package as a project. */
export default defineConfig({
  test: {
    projects: ["packages/*"],
  },
});
