import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COMPILE_TARGETS, compilePlugins, readSources, writeTargets } from "../src/index.js";
import { FIXTURE } from "./fixtures.js";

const temps: string[] = [];
const tempRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-compiler-"));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const plant = (root: string, files: Readonly<Record<string, string>>): void => {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
};

describe("readSources", () => {
  it("reads roles/, skills/ and plugins/ as sorted POSIX paths and skips OS litter", () => {
    const root = tempRoot();
    plant(root, { ...FIXTURE, "roles/.DS_Store": "x", "docs/ignored.md": "x" });
    const paths = readSources(root).map((f) => f.path);
    expect(paths).toEqual(Object.keys(FIXTURE).sort());
  });
});

describe("writeTargets", () => {
  it("writes both plugin trees under dist/ and removes stale files", () => {
    const root = tempRoot();
    plant(root, FIXTURE);
    plant(root, { [`${COMPILE_TARGETS["claude-code"]}/agents/stale.md`]: "old" });
    const result = compilePlugins(readSources(root));
    if (!result.ok) throw new Error(JSON.stringify(result.errors));
    const written = writeTargets(result.output, root);
    expect(existsSync(join(root, COMPILE_TARGETS["claude-code"], "agents/stale.md"))).toBe(false);
    expect(
      readFileSync(join(root, COMPILE_TARGETS.codex, "agents/vtc-qa-judge.toml"), "utf8"),
    ).toContain('name = "vtc-qa-judge"');
    expect(written).toContain(`${COMPILE_TARGETS["claude-code"]}/.mcp.json`);
  });
});
