/** AD-15: every file in the repo has exactly one owning team; the matcher behaves like a glob. */
import { describe, expect, it } from "vitest";
import {
  globToRegExp,
  loadOwnership,
  ownersOf,
  repoFiles,
  scopeViolations,
  teamOwns,
} from "../src/ownership.ts";

const map = loadOwnership();

describe("tooling/ownership.json (AD-15)", () => {
  it("names the seven build teams and the integrator (D-bb adds lookback-research)", () => {
    expect(Object.keys(map.teams).sort()).toEqual(
      [
        "adapters",
        "cli-binary",
        "dashboard",
        "engine-core",
        "gate-runner",
        "integrator",
        "lookback-research",
        "roles-compiler",
      ].sort(),
    );
  });
  it("gives every file in the repo exactly one owner", () => {
    const problems = repoFiles()
      .map((path) => [path, ownersOf(map, path)] as const)
      .filter(([, owners]) => owners.length !== 1)
      .map(([path, owners]) => `${path}: ${owners.length === 0 ? "no owner" : owners.join(", ")}`);
    expect(problems).toEqual([]);
  });
  it.each([
    ["packages/engine/src/index.ts", "integrator"],
    ["packages/engine/package.json", "integrator"],
    ["packages/engine/src/core/lock.ts", "engine-core"],
    ["packages/engine/src/daemon/index.ts", "engine-core"],
    ["packages/engine/src/gates/index.ts", "gate-runner"],
    ["packages/engine/test/gates/l2.test.ts", "gate-runner"],
    ["packages/engine/test/instance.test.ts", "engine-core"],
    ["packages/shared/src/helpers/redaction.ts", "gate-runner"],
    ["packages/shared/src/task.ts", "integrator"],
    ["packages/cli/src/commands/calibrate.ts", "gate-runner"],
    ["packages/cli/src/commands/engine.ts", "cli-binary"],
    ["plugins/claude-code/.mcp.json", "roles-compiler"],
    ["apps/dashboard/src/app/page.tsx", "dashboard"],
    ["fixtures/golden-run/events.jsonl", "engine-core"],
    ["fixtures/dashboard-export/index.html", "dashboard"],
    ["pnpm-lock.yaml", "integrator"],
    // wave 3 (D-bb, D-az, D-ay)
    ["packages/engine/src/lookback/index.ts", "lookback-research"],
    ["packages/engine/src/research/fetchers/eol.ts", "lookback-research"],
    ["packages/engine/test/lookback/replay.test.ts", "lookback-research"],
    ["packages/engine/test/research/cache.test.ts", "lookback-research"],
    ["packages/engine/src/core/scheduler.ts", "engine-core"],
    ["packages/engine/src/gates/visual/runner.ts", "gate-runner"],
    ["THIRD_PARTY/impeccable/LICENSE", "gate-runner"],
    ["NOTICE", "gate-runner"],
    [".github/workflows/release.yml", "cli-binary"],
    [".github/workflows/ci.yml", "integrator"],
    ["packaging/install.sh", "cli-binary"],
    ["packaging/homebrew/vtc.rb.tmpl", "cli-binary"],
  ])("%s belongs to %s", (path, team) => {
    expect(ownersOf(map, path)).toEqual([team]);
  });
});

describe("verify:scope (AD-15 rule 2: dependencies and the lockfile)", () => {
  it("lets a team that adds a dependency in its own package.json commit the regenerated lockfile", () => {
    expect(map.regenerated).toEqual(["pnpm-lock.yaml"]);
    for (const team of Object.keys(map.teams)) {
      expect(scopeViolations(map, team, ["pnpm-lock.yaml"]), team).toEqual([]);
    }
    expect(
      scopeViolations(map, "dashboard", ["apps/dashboard/package.json", "pnpm-lock.yaml"]),
    ).toEqual([]);
  });
  it("still fails on every other file the team does not own", () => {
    expect(
      scopeViolations(map, "dashboard", [
        "apps/dashboard/package.json",
        "pnpm-lock.yaml",
        "package.json",
        "pnpm-workspace.yaml",
        "packages/engine/package.json",
      ]),
    ).toEqual(["package.json", "pnpm-workspace.yaml", "packages/engine/package.json"]);
    expect(scopeViolations(map, "gate-runner", ["packages/engine/src/git/index.ts"])).toEqual([
      "packages/engine/src/git/index.ts",
    ]);
    // D-bb: lookback/ and research/ moved from engine-core to lookback-research
    expect(
      scopeViolations(map, "engine-core", [
        "packages/engine/src/lookback/index.ts",
        "packages/engine/test/research/cache.test.ts",
      ]),
    ).toEqual([
      "packages/engine/src/lookback/index.ts",
      "packages/engine/test/research/cache.test.ts",
    ]);
    expect(
      scopeViolations(map, "lookback-research", [
        "packages/engine/src/research/index.ts",
        "packages/engine/src/core/index.ts",
        "packages/engine/src/index.ts",
      ]),
    ).toEqual(["packages/engine/src/core/index.ts", "packages/engine/src/index.ts"]);
  });
});

describe("glob matcher", () => {
  it.each([
    ["packages/**", "packages/a/b/c.ts", true],
    ["packages/*/tsconfig*.json", "packages/a/tsconfig.build.json", true],
    ["packages/*/tsconfig*.json", "packages/a/b/tsconfig.json", false],
    ["tsconfig*.json", "packages/a/tsconfig.json", false],
    ["tsconfig*.json", "tsconfig.base.json", true],
    ["src/**/x.ts", "src/x.ts", true],
    ["a.b", "aXb", false],
  ])("%s ~ %s = %s", (glob, path, expected) => {
    expect(globToRegExp(glob).test(path)).toBe(expected);
  });
  it("applies ! exclusions", () => {
    expect(teamOwns(["a/**", "!a/b/**"], "a/c.ts")).toBe(true);
    expect(teamOwns(["a/**", "!a/b/**"], "a/b/c.ts")).toBe(false);
  });
});
