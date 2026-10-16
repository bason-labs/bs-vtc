/**
 * Opt-in live check of the two-pass install (H-14, `scriptsFreeInstall`) against the real package
 * managers on this machine: after the first pass no lifecycle script ran, and after the second the
 * dependency's `postinstall` and the project's own install scripts did. Each manager that is not on
 * `PATH` is skipped. Nothing is downloaded: the one dependency is a local tarball, and every cache
 * and store is a temp directory.
 *
 * Skipped unless `VTC_LIVE_PM=1`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scriptsFreeInstall } from "../../src/gates/tool-integrity.js";
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
 * its own postinstall writing `root.txt`. As a `workspace`, the dependency and a postinstall
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
      scripts: { postinstall: mark(join(dir, "root.txt"), "root") },
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
        const marks = workspace ? ["dep.txt", "root.txt", "a.txt"] : ["dep.txt", "root.txt"];
        // A lockfile, then a clean tree, as a checkout of a commit has.
        run(lock);
        for (const path of ["node_modules", "packages/a/node_modules", ...marks]) {
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
        run(passes.build);
        expect(readFileSync(join(dir, "dep.txt"), "utf8")).toBe("built\n");
        expect(readFileSync(join(dir, "root.txt"), "utf8")).toBe("root\n");
        if (workspace) expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("a\n");
      });
    }
  }
});
