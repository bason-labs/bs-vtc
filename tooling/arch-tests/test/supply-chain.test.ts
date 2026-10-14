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

/**
 * AD-24 rule 6 (spine §5 reading 106): axe-core is MPL-2.0 and never embedded. It comes
 * unmodified from the project or the doctor-installed store, so no production dependency closure
 * holds it and no tracked or built file is a copy of it. Checked on every git-tracked file and on
 * the build outputs present (`packages/*\/dist`, `apps/*\/dist`, the binary's directory).
 */
describe("axe-core is never embedded (AD-24 rule 6)", () => {
  const AXE_BANNER = /\/\*!\s*axe v\d|Deque Systems, Inc\./;
  const builtFiles = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((entry) => {
          const path = join(dir, entry);
          if (entry === "node_modules") return [];
          return statSync(path).isDirectory() ? builtFiles(path) : [path];
        })
      : [];
  const files = [
    ...repoFiles().map((path) => join(REPO_ROOT, path)),
    ...workspaceDirs.flatMap((ws) => builtFiles(join(ws, "dist"))),
  ];
  it("no production dependency is axe-core", () => {
    const names = new Set<string>();
    for (const ws of workspaceDirs) {
      const pkg = readPkg(ws);
      for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies }))
        names.add(dep);
    }
    expect([...names]).not.toContain("axe-core");
  });
  it("no tracked or built file is axe-core", () => {
    const hits = files.filter((path) => {
      if (/(^|\/)axe(\.min)?\.js$/.test(path)) return true;
      try {
        if (statSync(path).size > 64 * 1024 * 1024) return false;
        return AXE_BANNER.test(readFileSync(path, "latin1"));
      } catch {
        return false;
      }
    });
    expect(hits).toEqual([]);
  });
});

/** AD-24 rule 7: every THIRD_PARTY entry carries its licence and upstream source, named in NOTICE. */
describe("THIRD_PARTY entries are attributed (AD-24 rule 7)", () => {
  const root = join(REPO_ROOT, "THIRD_PARTY");
  const entries = existsSync(root)
    ? readdirSync(root).filter((name) => statSync(join(root, name)).isDirectory())
    : [];
  const notice = existsSync(join(REPO_ROOT, "NOTICE"))
    ? readFileSync(join(REPO_ROOT, "NOTICE"), "utf8")
    : "";
  it("has the ported detector's entry", () => {
    expect(entries).toContain("impeccable");
  });
  it.each(entries)("%s has LICENSE and SOURCE and is named in NOTICE", (name) => {
    expect(existsSync(join(root, name, "LICENSE"))).toBe(true);
    expect(existsSync(join(root, name, "SOURCE"))).toBe(true);
    expect(notice).toContain(name);
  });
});
