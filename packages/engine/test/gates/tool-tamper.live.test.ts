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

/** A project depending on a local tarball whose postinstall writes `dep.txt` in the project. */
const project = (): { dir: string; env: NodeJS.ProcessEnv } => {
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
  writeFile(
    dir,
    "package.json",
    JSON.stringify({
      name: "app",
      version: "1.0.0",
      dependencies: { dep: "file:../dep-1.0.0.tgz" },
      scripts: { postinstall: mark(join(dir, "root.txt"), "root") },
      pnpm: { onlyBuiltDependencies: ["dep"] },
      trustedDependencies: ["dep"],
    }),
  );
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
    it.skipIf(!onPath(pm))(pm, () => {
      const { dir, env } = project();
      const run = (argv: readonly string[]): void => {
        execFileSync(argv[0] ?? "", argv.slice(1), { cwd: dir, env, stdio: "pipe" });
      };
      // A lockfile, then a clean tree, as a checkout of a commit has.
      run(lock);
      for (const path of ["node_modules", "dep.txt", "root.txt"]) {
        rmSync(join(dir, path), { recursive: true, force: true });
      }
      const passes = scriptsFreeInstall(install);
      if (passes?.build === null || passes === null) throw new Error(`no two passes for ${pm}`);
      run(passes.free);
      expect(existsSync(join(dir, "node_modules/dep/package.json"))).toBe(true);
      expect(existsSync(join(dir, "dep.txt"))).toBe(false);
      expect(existsSync(join(dir, "root.txt"))).toBe(false);
      run(passes.build);
      expect(readFileSync(join(dir, "dep.txt"), "utf8")).toBe("built\n");
      expect(readFileSync(join(dir, "root.txt"), "utf8")).toBe("root\n");
    });
  }
});
