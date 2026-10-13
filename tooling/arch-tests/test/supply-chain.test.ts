/**
 * AD-2 rule 8 and AD-9 checks over things no import graph sees:
 * - production npm dependencies stay pure JS/WASM: no native addon, no install script, so
 *   `bun build --compile` keeps working (AD-2);
 * - role, skill and plugin sources never name a permission-bypass flag or credential marker,
 *   not even as a prohibition (AD-9).
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { findForbiddenInText } from "@vtc/shared";
import { REPO_ROOT, repoFiles } from "../src/ownership.ts";

interface PackageJson {
  readonly name?: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly scripts?: Record<string, string>;
  readonly gypfile?: boolean;
}

const readPkg = (dir: string): PackageJson =>
  JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as PackageJson;

/** Node-style lookup of `name` from `fromDir` (works with pnpm's symlinked layout). */
const resolvePackageDir = (name: string, fromDir: string): string | null => {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return null;
  }
};

const hasNativeFile = (dir: string): boolean =>
  readdirSync(dir).some((entry) => {
    if (entry === "node_modules") return false;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return hasNativeFile(path);
    return entry.endsWith(".node") || entry === "binding.gyp";
  });

const workspaceDirs = ["packages", "apps"].flatMap((group) => {
  const root = join(REPO_ROOT, group);
  return existsSync(root)
    ? readdirSync(root)
        .map((name) => join(root, name))
        .filter((dir) => existsSync(join(dir, "package.json")))
    : [];
});

describe("production dependencies are binary-safe (AD-2)", () => {
  const seen = new Map<string, string>();
  const visit = (name: string, fromDir: string): void => {
    const dir = resolvePackageDir(name, fromDir);
    if (dir === null) throw new Error(`cannot resolve ${name} from ${fromDir}`);
    if (seen.has(dir)) return;
    seen.set(dir, name);
    const pkg = readPkg(dir);
    for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
      visit(dep, dir);
    }
  };
  for (const ws of workspaceDirs) {
    const pkg = readPkg(ws);
    for (const [dep, range] of Object.entries({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    })) {
      if (!range.startsWith("workspace:")) visit(dep, ws);
    }
  }
  it("found the production dependency closure", () => {
    expect([...seen.values()]).toContain("zod");
  });
  it("no production dependency ships a native addon or an install script", () => {
    const problems: string[] = [];
    for (const [dir, name] of seen) {
      const pkg = readPkg(dir);
      for (const script of ["preinstall", "install", "postinstall"]) {
        if (pkg.scripts?.[script] !== undefined) problems.push(`${name}: ${script} script`);
      }
      if (pkg.gypfile === true || hasNativeFile(dir)) problems.push(`${name}: native addon`);
    }
    expect(problems).toEqual([]);
  });
});

describe("role, skill and plugin sources carry no AD-9 marker", () => {
  const sources = repoFiles().filter((path) => /^(roles|skills|plugins)\//.test(path));
  it("scans the source directories", () => {
    expect(sources).toContain("plugins/claude-code/.mcp.json");
  });
  it.each(sources)("%s", (path) => {
    expect(findForbiddenInText(readFileSync(join(REPO_ROOT, path), "utf8"))).toEqual([]);
  });
});
