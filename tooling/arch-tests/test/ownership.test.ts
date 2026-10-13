/** AD-15: every file in the repo has exactly one owning team; the matcher behaves like a glob. */
import { describe, expect, it } from "vitest";
import { globToRegExp, loadOwnership, ownersOf, repoFiles, teamOwns } from "../src/ownership.ts";

const map = loadOwnership();

describe("tooling/ownership.json (AD-15)", () => {
  it("names the six build teams and the integrator", () => {
    expect(Object.keys(map.teams).sort()).toEqual(
      [
        "adapters",
        "cli-binary",
        "dashboard",
        "engine-core",
        "gate-runner",
        "integrator",
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
  ])("%s belongs to %s", (path, team) => {
    expect(ownersOf(map, path)).toEqual([team]);
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
