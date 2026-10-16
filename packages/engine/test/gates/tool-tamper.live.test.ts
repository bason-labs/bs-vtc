/**
 * Opt-in live check of the two-pass install (H-14, `scriptsFreeInstall`) against the real package
 * managers on this machine: after the first pass no lifecycle script ran, and after the second,
 * run one writer at a time where VTC knows how (`perPackageBuild`, spine §5 reading 253: npm and
 * pnpm), each once: the dependency's `postinstall` and the project's own install scripts. Each manager that is not on
 * `PATH` is skipped. Nothing is downloaded: the one dependency is a local tarball, and every cache
 * and store is a temp directory.
 *
 * Skipped unless `VTC_LIVE_PM=1`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { delimiter, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareInstall,
  perPackageBuild,
  scriptsFreeInstall,
  workspaceTree,
} from "../../src/gates/tool-integrity.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

const live = process.env.VTC_LIVE_PM === "1";

const onPath = (name: string): boolean =>
  (process.env.PATH ?? "")
    .split(delimiter)
    .some((dir) => dir !== "" && existsSync(join(dir, name)));

/** A script that appends `text` to the file at `path` (absolute: no script's cwd is assumed). */
const mark = (path: string, text: string): string =>
  `node -e "require('fs').appendFileSync(${JSON.stringify(path).replaceAll('"', "'")}, '${text}\\n')"`;

/**
 * A project depending on a local tarball whose postinstall writes `dep.txt` in the project, with
 * its own postinstall writing `dist/root.txt` (a build output, spine §5 reading 254(3)). As a `workspace`, the dependency and a postinstall
 * writing `a.txt` belong to the workspace package `packages/a` instead, and the root keeps its own.
 */
const project = (workspace: boolean): { dir: string; env: NodeJS.ProcessEnv } => {
  const work = tempDir("vtc-live-pm-");
  const dir = join(work, "app");
  writeFile(
    work,
    "dep/package/package.json",
    JSON.stringify({
      name: "dep",
      version: "1.0.0",
      scripts: { postinstall: mark(join(dir, "dep.txt"), "built") },
    }),
  );
  execFileSync("tar", ["-czf", join(work, "dep-1.0.0.tgz"), "-C", join(work, "dep"), "package"]);
  const dependencies = { dep: `file:${join(work, "dep-1.0.0.tgz")}` };
  writeFile(
    dir,
    "package.json",
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      private: true,
      ...(workspace ? { workspaces: ["packages/*"] } : { dependencies }),
      scripts: {
        postinstall: `node -e "require('fs').mkdirSync('dist',{recursive:true})" && ${mark(join(dir, "dist/root.txt"), "root")}`,
      },
      pnpm: { onlyBuiltDependencies: ["dep"] },
      trustedDependencies: ["dep"],
    }),
  );
  if (workspace) {
    writeFile(dir, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
    writeFile(
      dir,
      "packages/a/package.json",
      JSON.stringify({
        name: "a",
        version: "1.0.0",
        dependencies,
        scripts: { postinstall: mark(join(dir, "a.txt"), "a") },
      }),
    );
  }
  writeFile(dir, ".npmrc", `side-effects-cache=false\nstore-dir=${join(work, "pnpm-store")}\n`);
  // Nothing of the package manager that started the tests (INIT_CWD, npm_config_*) leaks in.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "INIT_CWD" && !/^npm_/i.test(k)),
  );
  env.npm_config_cache = join(work, "npm-cache");
  env.BUN_INSTALL_CACHE_DIR = join(work, "bun-cache");
  return { dir, env };
};

const MANAGERS: readonly { pm: string; lock: string[]; install: string[] }[] = [
  {
    pm: "npm",
    lock: ["npm", "install", "--no-audit", "--no-fund"],
    install: ["npm", "ci", "--no-audit", "--no-fund"],
  },
  {
    pm: "pnpm",
    lock: ["pnpm", "install"],
    install: ["pnpm", "install", "--frozen-lockfile"],
  },
  { pm: "bun", lock: ["bun", "install"], install: ["bun", "install", "--frozen-lockfile"] },
];

describe.skipIf(!live)("live: the second install pass runs the scripts the first skipped", () => {
  for (const { pm, lock, install } of MANAGERS) {
    for (const workspace of [false, true]) {
      it.skipIf(!onPath(pm))(`${pm}${workspace ? " (workspace)" : ""}`, () => {
        const { dir, env } = project(workspace);
        const run = (argv: readonly string[]): void => {
          execFileSync(argv[0] ?? "", argv.slice(1), { cwd: dir, env, stdio: "pipe" });
        };
        const marks = workspace
          ? ["dep.txt", "dist/root.txt", "a.txt"]
          : ["dep.txt", "dist/root.txt"];
        // A lockfile, then a clean tree, as a checkout of a commit has.
        run(lock);
        for (const path of ["node_modules", "packages/a/node_modules", "dist", ...marks]) {
          rmSync(join(dir, path), { recursive: true, force: true });
        }
        const passes = scriptsFreeInstall(install);
        if (passes?.build === null || passes === null) throw new Error(`no two passes for ${pm}`);
        run(passes.free);
        // npm hoists a workspace package's dependency to the root; pnpm and Bun link it there.
        const installed = ["node_modules/dep", "packages/a/node_modules/dep"].some((at) =>
          existsSync(join(dir, at, "package.json")),
        );
        expect(installed).toBe(true);
        for (const path of marks) expect(existsSync(join(dir, path)), path).toBe(false);
        // spine §5 reading 253: one writer at a time where the package manager has a form for it
        const steps = perPackageBuild(install, dir, "", workspaceTree(dir, { writable: [] }));
        if (pm === "bun") expect(steps).toBeNull();
        else expect(steps?.length).toBeGreaterThan(0);
        // each step changes nothing but what its own writer may, besides the marks the
        // fixture's scripts write at the project root (a dependency's or packages/a's: tampering)
        let before = workspaceTree(dir, { writable: [] });
        for (const step of steps ?? [{ argv: passes.build, writer: null }]) {
          run(step.argv);
          const after = workspaceTree(dir, { writable: [] });
          const marks = compareInstall(before, after, undefined, step.writer).tampered;
          const own =
            step.writer !== null && "project" in step.writer && step.writer.project === "";
          if (steps !== null)
            expect(
              marks.every((m) => /^(dep|a)\.txt$/.test(m)),
              marks.join(),
            ).toBe(true);
          if (own) expect(marks).toEqual([]);
          before = after;
        }
        expect(readFileSync(join(dir, "dep.txt"), "utf8")).toBe("built\n");
        expect(readFileSync(join(dir, "dist/root.txt"), "utf8")).toBe("root\n");
        if (workspace) expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
      });
    }
  }
});

/**
 * The h14-open3 finding's reproduction (spine §5 readings 254(1) and 255): the project depends on esbuild
 * and on a helper from a committed tarball that depends on a second package named esbuild, whose
 * postinstall patches the first one's lib/main.js. pnpm runs with `onlyBuiltDependencies:
 * [esbuild]`, which matches both by name.
 */
const twoEsbuilds = (): { dir: string; env: NodeJS.ProcessEnv } => {
  const work = tempDir("vtc-live-pm-");
  const dir = join(work, "app");
  const tarball = (
    name: string,
    version: string,
    extra: Record<string, unknown>,
    files: Record<string, string> = {},
  ): string => {
    const src = join(work, `${name}-${version}`);
    writeFile(src, "package/package.json", JSON.stringify({ name, version, ...extra }));
    for (const [path, text] of Object.entries(files)) writeFile(src, `package/${path}`, text);
    const out = join(work, `${name}-${version}.tgz`);
    execFileSync("tar", ["-czf", out, "-C", src, "package"]);
    return `file:${out}`;
  };
  const real = tarball(
    "esbuild",
    "1.0.0",
    { scripts: { postinstall: "node install.js" }, bin: { esbuild: "bin/esbuild" } },
    {
      "install.js": "require('fs').writeFileSync('bin/esbuild', 'native');\n",
      "bin/esbuild": "#!/usr/bin/env node\n",
      "lib/main.js": "exports.transform = (code) => code;\n",
    },
  );
  const main = join(dir, "node_modules/esbuild/lib/main.js");
  const fake = tarball(
    "esbuild",
    "0.0.1",
    { scripts: { postinstall: "node install.js" } },
    {
      "install.js": `require('fs').writeFileSync(${JSON.stringify(main)}, "exports.transform = (code) => code.replace(/expect\\\\(/g, 'void (');\\n");\n`,
    },
  );
  const helper = tarball("helper", "1.0.0", { dependencies: { esbuild: fake } });
  writeFile(
    dir,
    "package.json",
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      private: true,
      dependencies: { esbuild: real, helper },
      pnpm: { onlyBuiltDependencies: ["esbuild"] },
    }),
  );
  writeFile(dir, ".npmrc", `side-effects-cache=false\nstore-dir=${join(work, "pnpm-store")}\n`);
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k !== "INIT_CWD" && !/^npm_/i.test(k)),
  );
  env.npm_config_cache = join(work, "npm-cache");
  return { dir, env };
};

describe.skipIf(!live)("live: two installed packages named esbuild (spine §5 reading 254)", () => {
  for (const { pm, lock, install } of MANAGERS.filter((m) => m.pm !== "bun")) {
    it.skipIf(!onPath(pm))(pm, () => {
      const { dir, env } = twoEsbuilds();
      const run = (argv: readonly string[]): void => {
        execFileSync(argv[0] ?? "", argv.slice(1), { cwd: dir, env, stdio: "pipe" });
      };
      run(lock);
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      const passes = scriptsFreeInstall(install);
      if (passes?.build === null || passes === null) throw new Error(`no two passes for ${pm}`);
      run(passes.free);
      const realDir = relative(realpathSync(dir), realpathSync(join(dir, "node_modules/esbuild")));
      const main = `${realDir}/lib/main.js`;
      const steps = perPackageBuild(install, dir, "", workspaceTree(dir, { writable: [] })) ?? [];
      // npm by location, one step each; pnpm by name, one step running both
      expect(steps.map((s) => s.argv.slice(1).join(" "))).toEqual(
        pm === "npm"
          ? ["rebuild ./node_modules/esbuild", "rebuild ./node_modules/helper/node_modules/esbuild"]
          : ["rebuild --recursive esbuild"],
      );
      let before = workspaceTree(dir, { writable: [] });
      const tampered: string[] = [];
      const rebuilt: string[] = [];
      for (const step of steps) {
        run(step.argv);
        const after = workspaceTree(dir, { writable: [] });
        const compared = compareInstall(before, after, undefined, step.writer);
        tampered.push(...compared.tampered);
        rebuilt.push(...compared.selfRebuilt.map((r) => r.package));
        before = after;
      }
      // the patch happened, and it is tampering. npm rebuilt by location, so the real esbuild's
      // binary is its own (spine §5 reading 255); pnpm by name, and both esbuilds come from
      // tarballs, so neither may rebuild itself
      expect(readFileSync(join(dir, main), "utf8")).toMatch(/void \(/);
      expect(tampered).toContain(main);
      if (pm === "npm") {
        expect(tampered).not.toContain(`${realDir}/bin/esbuild`);
        expect(rebuilt.filter((p) => p.endsWith("/esbuild"))).toEqual([realDir]);
      } else {
        expect(tampered).toContain(`${realDir}/bin/esbuild`);
        expect(rebuilt.filter((p) => p.endsWith("/esbuild"))).toEqual([]);
      }
    });
  }
});

describe.skipIf(!live)("live: pnpm rebuilds by name and version (spine §5 reading 255)", () => {
  it.skipIf(!onPath("pnpm"))(
    "`rebuild --recursive dep@2.0.0` runs that version's script only",
    () => {
      const work = tempDir("vtc-live-pm-");
      const dir = join(work, "app");
      const log = join(work, "log.txt");
      const tarball = (name: string, version: string, extra: Record<string, unknown>): string => {
        const src = join(work, `${name}-${version}`);
        writeFile(src, "package/package.json", JSON.stringify({ name, version, ...extra }));
        const out = join(work, `${name}-${version}.tgz`);
        execFileSync("tar", ["-czf", out, "-C", src, "package"]);
        return `file:${out}`;
      };
      const dep = (version: string): string =>
        tarball("dep", version, { scripts: { postinstall: mark(log, version) } });
      const helper = tarball("helper", "1.0.0", { dependencies: { dep: dep("2.0.0") } });
      writeFile(
        dir,
        "package.json",
        JSON.stringify({
          name: "app",
          version: "1.0.0",
          private: true,
          dependencies: { dep: dep("1.0.0"), helper },
          pnpm: { onlyBuiltDependencies: ["dep"] },
        }),
      );
      writeFile(dir, ".npmrc", `side-effects-cache=false\nstore-dir=${join(work, "pnpm-store")}\n`);
      const env: NodeJS.ProcessEnv = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => k !== "INIT_CWD" && !/^npm_/i.test(k)),
      );
      const run = (...args: string[]): void => {
        execFileSync("pnpm", args, { cwd: dir, env, stdio: "pipe" });
      };
      run("install", "--ignore-scripts");
      expect(existsSync(log)).toBe(false);
      run("rebuild", "--recursive", "dep@2.0.0");
      expect(readFileSync(log, "utf8")).toBe("2.0.0\n");
      run("rebuild", "--recursive", "dep@1.0.0");
      expect(readFileSync(log, "utf8")).toBe("2.0.0\n1.0.0\n");
    },
  );
});
