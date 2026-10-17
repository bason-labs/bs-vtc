/**
 * Every rule in .dependency-cruiser.cjs fires on a planted violation (fixtures/repo), and the
 * allowed shapes (dashboard .tsx with extensionless and `@/` imports, the shared entry, engine
 * modules through their index) stay clean. Runs the real `depcruise` CLI like `pnpm deps:check`.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface Violation {
  readonly from: string;
  readonly to: string;
  readonly rule: { readonly name: string };
}

const fixtureRoot = fileURLToPath(new URL("../fixtures/repo/", import.meta.url));
const configPath = fileURLToPath(new URL("../../../.dependency-cruiser.cjs", import.meta.url));
const depcruiseBin = fileURLToPath(new URL("../node_modules/.bin/depcruise", import.meta.url));
const config = createRequire(import.meta.url)(configPath) as {
  forbidden: readonly { name: string }[];
};

const cruise = (): Violation[] => {
  const result = spawnSync(
    depcruiseBin,
    ["packages", "apps", "--config", configPath, "--output-type", "json"],
    { cwd: fixtureRoot, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
  );
  if (result.stdout === "") throw new Error(`depcruise produced no output: ${result.stderr}`);
  const report = JSON.parse(result.stdout) as { summary: { violations: Violation[] } };
  return report.summary.violations;
};

const violations = cruise();
const rulesFor = (from: string): string[] =>
  violations.filter((v) => v.from === from).map((v) => v.rule.name);

const EXPECTED: readonly (readonly [file: string, rule: string])[] = [
  ["packages/shared/src/bad-internal.ts", "AD1-shared-has-no-internal-deps"],
  ["packages/shared/src/bad-node.ts", "AD2-shared-is-runtime-agnostic"],
  ["packages/adapters/src/claude-code/bad.ts", "AD1-adapter-families-are-isolated"],
  ["packages/adapters/src/bad-engine.ts", "AD1-adapters-depend-only-on-shared"],
  ["packages/adapters/src/bad-dist.ts", "AD1-no-imports-of-build-output"],
  ["packages/engine/src/bad-adapters.ts", "AD1-engine-uses-adapter-interfaces-only"],
  ["packages/compiler/src/bad.ts", "AD1-compiler-depends-only-on-shared"],
  ["packages/engine/src/bad-cli.ts", "AD1-nothing-imports-the-cli"],
  ["apps/dashboard/src/bad-engine.tsx", "AD1-dashboard-talks-to-engine-over-http-only"],
  ["packages/engine/src/bad-apps.ts", "AD1-no-package-imports-apps"],
  ["packages/cli/src/bad-deep.ts", "AD1-no-deep-imports-across-packages"],
  ["apps/dashboard/src/bad-deep.tsx", "AD1-no-deep-imports-across-packages"],
  ["packages/cli/test/bad-test-deep.ts", "AD1-test-support-through-the-sanctioned-entry"],
  ["packages/engine/src/bad-sqlite.ts", "AD2-node-sqlite-only-in-its-driver"],
  ["packages/engine/src/bad-bun.ts", "AD2-bun-builtins-only-in-bun-driver"],
  ["packages/engine/src/bad-builtin.ts", "AD2-runtime-builtins-allowlist"],
  ["packages/engine/src/bad-storage.ts", "AD2-storage-drivers-loaded-by-the-entry-only"],
  ["packages/engine/src/http/bad-deep.ts", "AD13-engine-modules-use-each-others-entry"],
  ["packages/engine/src/core/bad-gates.ts", "AD13-core-uses-the-gate-runner-interface"],
  ["packages/engine/src/daemon/bad-gates.ts", "AD13-core-uses-the-gate-runner-interface"],
  ["packages/engine/src/core/bad-daemon.ts", "AD19-only-the-engine-entry-imports-the-daemon"],
  ["packages/engine/src/gates/bad.ts", "AD13-gates-never-import-engine-core"],
  ["packages/engine/src/git/bad.ts", "AD13-git-imports-no-engine-module"],
  ["packages/engine/src/core/bad-transport.ts", "AD13-core-does-not-import-transports"],
  ["packages/engine/src/core/bad-lookback.ts", "AD13-core-does-not-import-lookback-or-research"],
  ["packages/engine/src/gates/bad-research.ts", "AD13-core-does-not-import-lookback-or-research"],
  ["packages/engine/src/lookback/bad.ts", "AD21-lookback-uses-core-and-the-gate-interface"],
  ["packages/engine/src/research/bad.ts", "AD22-research-is-a-leaf"],
  ["packages/engine/src/core/bad-upstream.ts", "AD27-only-the-daemon-wires-upstream"],
  ["packages/engine/src/upstream/bad.ts", "AD27-upstream-uses-core-only"],
  ["packages/engine/src/bad-test.ts", "AD11-no-test-code-in-production"],
  ["packages/engine/src/bad-devdep.ts", "AD11-no-dev-deps-in-production"],
  ["apps/dashboard/src/bad-devdep.tsx", "AD11-no-dev-deps-in-production"],
  ["packages/compiler/src/cycle-a.ts", "no-circular"],
  ["packages/compiler/src/unresolvable.ts", "not-to-unresolvable"],
  ["packages/compiler/src/undeclared.ts", "no-undeclared-deps"],
];

describe("dependency-cruiser rules fire on planted violations", () => {
  it.each(EXPECTED)("%s violates %s", (file, rule) => {
    expect(rulesFor(file)).toContain(rule);
  });
  it("every configured rule is proven by at least one fixture", () => {
    const proven = new Set(EXPECTED.map(([, rule]) => rule));
    expect(config.forbidden.map((r) => r.name).filter((name) => !proven.has(name))).toEqual([]);
  });
  it.each([
    "apps/dashboard/src/page.tsx",
    "apps/dashboard/src/components/d.tsx",
    "packages/engine/src/core/ok.ts",
    "packages/engine/src/lookback/ok.ts",
    "packages/engine/src/upstream/ok.ts",
    "packages/engine/src/daemon/index.ts",
    "packages/engine/src/storage/node-sqlite.ts",
    "packages/engine/dist/index.js",
    "packages/cli/test/ok-test-support.ts",
  ])("allowed shapes stay clean: %s", (file) => {
    expect(rulesFor(file)).toEqual([]);
  });
});
