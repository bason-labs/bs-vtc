/**
 * Check-tool integrity (H-14; spine §5 readings 80(c) and 238): the scripts-free form of an
 * install command, the content hash of a tool's files, what changed between two hashes, and the
 * `project` tool derived from a gate command's executable.
 */
import { chmodSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedToolFiles,
  deriveProjectTool,
  hashTool,
  scriptsFreeInstall,
  TOOL_HASH_LIMITS,
  ToolHashLimitError,
  toolPathsCover,
} from "../../src/gates/tool-integrity.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const put = (root: string, rel: string, text: string, mode?: number): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
  if (mode !== undefined) chmodSync(join(root, rel), mode);
};

const link = (root: string, rel: string, target: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  symlinkSync(target, join(root, rel));
};

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

describe("scriptsFreeInstall: an install in two passes, the first running no lifecycle script", () => {
  it("adds the package manager's own switch, then the pass that runs the skipped scripts", () => {
    // npm ci reinstalls everything, so its scripts run; checked live (tool-tamper.live.test.ts).
    expect(scriptsFreeInstall(["npm", "ci"])).toEqual({
      free: ["npm", "ci", "--ignore-scripts"],
      build: ["npm", "ci"],
    });
    // A second pnpm install leaves the pending builds; `pnpm rebuild --pending` runs them.
    expect(scriptsFreeInstall(["/usr/local/bin/pnpm", "install", "--frozen-lockfile"])).toEqual({
      free: ["/usr/local/bin/pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      build: ["/usr/local/bin/pnpm", "rebuild", "--pending"],
    });
    expect(scriptsFreeInstall(["bun", "install", "--frozen-lockfile"])).toEqual({
      free: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      build: ["bun", "install", "--frozen-lockfile"],
    });
  });

  it("takes an install that runs no project code as it is, once", () => {
    expect(scriptsFreeInstall(["go", "mod", "download"])).toEqual({
      free: ["go", "mod", "download"],
      build: null,
    });
    expect(scriptsFreeInstall(["cargo", "fetch", "--locked"])).toEqual({
      free: ["cargo", "fetch", "--locked"],
      build: null,
    });
    expect(scriptsFreeInstall(["npm", "ci", "--ignore-scripts"])).toEqual({
      free: ["npm", "ci", "--ignore-scripts"],
      build: null,
    });
    expect(scriptsFreeInstall(["npm", "install", "--ignore-scripts"])?.build).toBeNull();
  });

  it("knows no scripts-free form of an install whose second pass would not run the scripts", () => {
    // `npm install` of an installed tree, Yarn's integrity check: no dependency script runs.
    expect(scriptsFreeInstall(["npm", "install"])).toBeNull();
    expect(scriptsFreeInstall(["npm", "i"])).toBeNull();
    expect(scriptsFreeInstall(["yarn", "install", "--immutable"])).toBeNull();
    expect(scriptsFreeInstall(["yarn", "install", "--frozen-lockfile"])).toBeNull();
    expect(scriptsFreeInstall(["uv", "sync", "--frozen"])).toBeNull();
    expect(scriptsFreeInstall(["npm", "run", "setup"])).toBeNull();
    expect(scriptsFreeInstall(["node", "tools/install.mjs"])).toBeNull();
  });
});

describe("hashTool: the tool's files, sorted path and content hash per line", () => {
  it("hashes every file under the globs and follows the package's own link", () => {
    const root = tempDir();
    put(root, "node_modules/.pnpm/lint@1.0.0/node_modules/lint/package.json", "{}");
    put(root, "node_modules/.pnpm/lint@1.0.0/node_modules/lint/bin/lint.js", "lint");
    link(root, "node_modules/lint", ".pnpm/lint@1.0.0/node_modules/lint");
    link(root, "node_modules/.bin/lint", "../lint/bin/lint.js");
    put(root, "node_modules/other/index.js", "not the tool");
    const snap = hashTool(root, ["node_modules/lint/**", "node_modules/.bin/lint"]);
    expect([...snap.files.keys()]).toEqual([
      "node_modules/.bin/lint",
      "node_modules/lint",
      "node_modules/lint/bin/lint.js",
      "node_modules/lint/package.json",
    ]);
    expect(snap.files.get("node_modules/lint/bin/lint.js")).toBe(sha("lint"));
    expect(snap.files.get("node_modules/.bin/lint")).toBe("link:../lint/bin/lint.js");
    const lines = [...snap.files].map(([p, h]) => `${p}\u0000${h}\n`).join("");
    expect(snap.sha256).toBe(sha(lines));
  });

  it("finds nothing where nothing is installed, and the same bytes hash the same", () => {
    const root = tempDir();
    expect(hashTool(root, ["node_modules/lint/**"]).files.size).toBe(0);
    put(root, "node_modules/lint/index.js", "same");
    const before = hashTool(root, ["node_modules/lint/**"]);
    rmSync(join(root, "node_modules"), { recursive: true });
    put(root, "node_modules/lint/index.js", "same");
    expect(hashTool(root, ["node_modules/lint/**"]).sha256).toBe(before.sha256);
  });

  it("refuses a tool bigger than it hashes, rather than hashing part of it", () => {
    const root = tempDir();
    for (let i = 0; i < 4; i += 1) put(root, `t/${String(i)}`, "xx");
    expect(() => hashTool(root, ["t/**"], { ...TOOL_HASH_LIMITS, maxFiles: 3 })).toThrow(
      /more than 3 files/,
    );
    expect(() => hashTool(root, ["t/**"], { ...TOOL_HASH_LIMITS, maxBytes: 7 })).toThrow(
      /more than 7 bytes/,
    );
    expect(hashTool(root, ["t/**"]).files.size).toBe(4);
  });
});

describe("hashTool: never reads outside the checkout", () => {
  it("records a package link that leads out of the checkout, and never walks its target", () => {
    const root = tempDir();
    const outside = tempDir();
    put(outside, "secret/token.txt", "host secret");
    link(root, "node_modules/lint", join(outside, "secret"));
    const snap = hashTool(root, ["node_modules/lint/**", "node_modules/.bin/lint"]);
    expect([...snap.files.keys()]).toEqual(["node_modules/lint"]);
    expect(snap.files.get("node_modules/lint")).toBe(`link:${join(outside, "secret")}`);
  });

  it("stops at a directory on the way that leads out of the checkout", () => {
    const root = tempDir();
    const outside = tempDir();
    put(outside, "lint/index.js", "host file");
    put(outside, ".bin/lint", "host file");
    symlinkSync(outside, join(root, "node_modules"));
    const snap = hashTool(root, ["node_modules/lint/**", "node_modules/.bin/lint"]);
    expect(Object.fromEntries(snap.files)).toEqual({
      "node_modules/.bin/lint": "outside-checkout",
      "node_modules/lint": "outside-checkout",
    });
  });

  it("refuses a file past the byte limit before reading it, naming that file", () => {
    const root = tempDir();
    put(root, "node_modules/lint/index.js", "");
    // Sparse: as big as the limit allows plus one, with nothing written.
    truncateSync(join(root, "node_modules/lint/index.js"), TOOL_HASH_LIMITS.maxBytes + 1);
    let thrown: unknown;
    try {
      hashTool(root, ["node_modules/lint/**"]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ToolHashLimitError);
    expect((thrown as ToolHashLimitError).path).toBe("node_modules/lint/index.js");
  });
});

describe("hashTool: a tool's dependencies are part of it", () => {
  const pkg = (root: string, dir: string, name: string, deps: Record<string, string> = {}) => {
    put(root, `${dir}/package.json`, JSON.stringify({ name, dependencies: deps }));
  };

  it("hashes a pnpm package's dependency closure through the virtual store, links as lines", () => {
    const root = tempDir();
    const store = "node_modules/.pnpm";
    pkg(root, `${store}/lint@1/node_modules/lint`, "lint", { dep: "1" });
    put(root, `${store}/lint@1/node_modules/lint/index.js`, "lint");
    link(root, `${store}/lint@1/node_modules/dep`, "../../dep@1/node_modules/dep");
    pkg(root, `${store}/dep@1/node_modules/dep`, "dep", { sub: "1", absent: "1" });
    put(root, `${store}/dep@1/node_modules/dep/index.js`, "dep");
    link(root, `${store}/dep@1/node_modules/sub`, "../../sub@1/node_modules/sub");
    pkg(root, `${store}/sub@1/node_modules/sub`, "sub");
    put(root, `${store}/sub@1/node_modules/sub/index.js`, "sub");
    pkg(root, `${store}/other@1/node_modules/other`, "other");
    link(root, "node_modules/lint", ".pnpm/lint@1/node_modules/lint");
    const before = hashTool(root, ["node_modules/lint/**"]);
    expect([...before.files.keys()]).toEqual([
      `${store}/dep@1/node_modules/dep/index.js`,
      `${store}/dep@1/node_modules/dep/package.json`,
      `${store}/dep@1/node_modules/sub`,
      `${store}/lint@1/node_modules/dep`,
      `${store}/sub@1/node_modules/sub/index.js`,
      `${store}/sub@1/node_modules/sub/package.json`,
      "node_modules/lint",
      "node_modules/lint/index.js",
      "node_modules/lint/package.json",
    ]);
    // A dependency's install script edits a file two levels down.
    put(root, `${store}/sub@1/node_modules/sub/index.js`, "evil");
    expect(changedToolFiles(before, hashTool(root, ["node_modules/lint/**"]))).toEqual([
      `${store}/sub@1/node_modules/sub/index.js`,
    ]);
  });

  it("resolves an npm tree's dependencies the way Node does, and sees a nearer copy planted", () => {
    const root = tempDir();
    pkg(root, "node_modules/lint", "lint", { dep: "1" });
    pkg(root, "node_modules/dep", "dep");
    put(root, "node_modules/dep/index.js", "dep");
    const before = hashTool(root, ["node_modules/lint/**"]);
    expect(before.files.has("node_modules/dep/index.js")).toBe(true);
    pkg(root, "node_modules/lint/node_modules/dep", "dep");
    put(root, "node_modules/lint/node_modules/dep/index.js", "evil");
    // The copy Node now loads is added, and the one it loaded before is no longer the tool's.
    expect(changedToolFiles(before, hashTool(root, ["node_modules/lint/**"]))).toEqual([
      "node_modules/dep/index.js",
      "node_modules/dep/package.json",
      "node_modules/lint/node_modules/dep/index.js",
      "node_modules/lint/node_modules/dep/package.json",
    ]);
  });

  it("never follows a dependency link out of the checkout", () => {
    const root = tempDir();
    const outside = tempDir();
    put(outside, "dep/package.json", "{}");
    put(outside, "dep/token.txt", "host secret");
    pkg(root, "node_modules/lint", "lint", { dep: "1" });
    link(root, "node_modules/dep", join(outside, "dep"));
    const snap = hashTool(root, ["node_modules/lint/**"]);
    expect([...snap.files.keys()]).toEqual(["node_modules/dep", "node_modules/lint/package.json"]);
    expect(snap.files.get("node_modules/dep")).toBe(`link:${join(outside, "dep")}`);
  });

  it("hashes a virtual environment script's distribution, what it requires and the startup files", () => {
    const root = tempDir();
    const site = ".venv/lib/python3.12/site-packages";
    put(root, ".venv/pyvenv.cfg", "home = /usr/bin\n");
    put(root, ".venv/bin/pytest", "#!/usr/bin/env python\nfrom pytest import console_main\n");
    put(
      root,
      `${site}/pytest-8.3.0.dist-info/entry_points.txt`,
      "[console_scripts]\npy.test = pytest:console_main\npytest = pytest:console_main\n",
    );
    put(
      root,
      `${site}/pytest-8.3.0.dist-info/METADATA`,
      'Name: pytest\nRequires-Dist: pluggy<2,>=1.5\nRequires-Dist: Pygments>=2.7; extra == "dev"\n',
    );
    put(
      root,
      `${site}/pytest-8.3.0.dist-info/RECORD`,
      "pytest/__init__.py,,\n_pytest/main.py,,\n../../../bin/pytest,,\npytest-8.3.0.dist-info/RECORD,,\n",
    );
    put(root, `${site}/pytest/__init__.py`, "pytest");
    put(root, `${site}/_pytest/main.py`, "main");
    put(root, `${site}/pluggy-1.5.0.dist-info/RECORD`, "pluggy/__init__.py,,\n");
    put(root, `${site}/pluggy-1.5.0.dist-info/METADATA`, "Name: pluggy\n");
    put(root, `${site}/pluggy/__init__.py`, "pluggy");
    put(root, `${site}/pygments-2.18.0.dist-info/RECORD`, "pygments/__init__.py,,\n");
    put(root, `${site}/pygments/__init__.py`, "an extra");
    put(root, `${site}/numpy/__init__.py`, "unrelated");
    put(root, `${site}/startup.pth`, "import os\n");
    const before = hashTool(root, [".venv/bin/pytest"]);
    expect([...before.files.keys()]).toEqual([
      ".venv/bin/pytest",
      `${site}/_pytest/main.py`,
      `${site}/pluggy-1.5.0.dist-info/METADATA`,
      `${site}/pluggy-1.5.0.dist-info/RECORD`,
      `${site}/pluggy/__init__.py`,
      `${site}/pytest-8.3.0.dist-info/METADATA`,
      `${site}/pytest-8.3.0.dist-info/RECORD`,
      `${site}/pytest-8.3.0.dist-info/entry_points.txt`,
      `${site}/pytest/__init__.py`,
      `${site}/startup.pth`,
    ]);
    put(root, `${site}/pluggy/_hooks.py`, "planted");
    expect(changedToolFiles(before, hashTool(root, [".venv/bin/pytest"]))).toEqual([
      `${site}/pluggy/_hooks.py`,
    ]);
  });
});

describe("toolPathsCover: configured paths against what the command runs", () => {
  it("accepts the same path or a glob over it, and nothing else", () => {
    const paths = ["node_modules/.bin/eslint", "node_modules/eslint/**"];
    expect(toolPathsCover(paths, "node_modules/eslint/**")).toBe(true);
    expect(toolPathsCover(paths, "node_modules/.bin/eslint")).toBe(true);
    expect(toolPathsCover(["node_modules/**"], "node_modules/eslint/**")).toBe(true);
    // A version-specific real path recorded before a dependency bump.
    const stale = ["node_modules/.pnpm/eslint@8.0.0/node_modules/eslint/**"];
    expect(toolPathsCover(stale, "node_modules/.pnpm/eslint@9.1.0/node_modules/eslint/**")).toBe(
      false,
    );
    expect(toolPathsCover(paths, "web/node_modules/.bin/eslint")).toBe(false);
  });
});

describe("changedToolFiles: what the install phase changed, added or removed", () => {
  it("lists every path whose content or link differs, sorted", () => {
    const root = tempDir();
    put(root, "node_modules/lint/a.js", "a");
    put(root, "node_modules/lint/b.js", "b");
    put(root, "node_modules/lint/c.js", "c");
    const before = hashTool(root, ["node_modules/lint/**"]);
    put(root, "node_modules/lint/a.js", "evil");
    rmSync(join(root, "node_modules/lint/b.js"));
    put(root, "node_modules/lint/d.js", "added");
    const after = hashTool(root, ["node_modules/lint/**"]);
    expect(changedToolFiles(before, after)).toEqual([
      "node_modules/lint/a.js",
      "node_modules/lint/b.js",
      "node_modules/lint/d.js",
    ]);
    expect(changedToolFiles(before, before)).toEqual([]);
  });

  it("sees a package link pointed somewhere else", () => {
    const root = tempDir();
    put(root, "node_modules/.pnpm/lint@1/node_modules/lint/index.js", "real");
    put(root, "evil/index.js", "real");
    link(root, "node_modules/lint", ".pnpm/lint@1/node_modules/lint");
    const before = hashTool(root, ["node_modules/lint/**"]);
    rmSync(join(root, "node_modules/lint"));
    link(root, "node_modules/lint", "../evil");
    expect(changedToolFiles(before, hashTool(root, ["node_modules/lint/**"]))).toEqual([
      "node_modules/lint",
    ]);
  });
});

describe("deriveProjectTool: the resolved executable and its package", () => {
  const nodeProject = (): string => {
    const root = tempDir();
    put(root, "node_modules/eslint/package.json", JSON.stringify({ name: "eslint" }));
    put(root, "node_modules/eslint/bin/eslint.js", "#!/usr/bin/env node\n", 0o755);
    link(root, "node_modules/.bin/eslint", "../eslint/bin/eslint.js");
    put(root, "node_modules/typescript/package.json", JSON.stringify({ name: "typescript" }));
    put(root, "node_modules/typescript/bin/tsc", "#!/usr/bin/env node\n", 0o755);
    link(root, "node_modules/.bin/tsc", "../typescript/bin/tsc");
    return root;
  };

  it("unwraps the package manager runners to the bin and its package", () => {
    const root = nodeProject();
    expect(deriveProjectTool(root, "", ["pnpm", "exec", "eslint", "."])).toEqual({
      source: "project",
      paths: ["node_modules/.bin/eslint", "node_modules/eslint/**"],
    });
    expect(deriveProjectTool(root, "", ["npx", "--no-install", "tsc", "--noEmit"])).toEqual({
      source: "project",
      paths: ["node_modules/.bin/tsc", "node_modules/typescript/**"],
    });
    expect(deriveProjectTool(root, "", ["node_modules/.bin/eslint", "."])?.paths).toEqual([
      "node_modules/.bin/eslint",
      "node_modules/eslint/**",
    ]);
    expect(deriveProjectTool(root, "", ["yarn", "eslint", "."])?.paths).toEqual([
      "node_modules/.bin/eslint",
      "node_modules/eslint/**",
    ]);
  });

  it("follows a pnpm shell shim to the package it starts", () => {
    const root = tempDir();
    put(
      root,
      "node_modules/.pnpm/vitest@5.0.4/node_modules/vitest/package.json",
      JSON.stringify({ name: "vitest" }),
    );
    put(root, "node_modules/.pnpm/vitest@5.0.4/node_modules/vitest/vitest.mjs", "run");
    link(root, "node_modules/vitest", ".pnpm/vitest@5.0.4/node_modules/vitest");
    put(
      root,
      "node_modules/.bin/vitest",
      '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node  "$basedir/../vitest/vitest.mjs" "$@"\n',
      0o755,
    );
    expect(deriveProjectTool(root, "", ["pnpm", "exec", "vitest", "run"])?.paths).toEqual([
      "node_modules/.bin/vitest",
      "node_modules/vitest/**",
    ]);
  });

  it("resolves from the gate's working directory up to the checkout", () => {
    const root = nodeProject();
    mkdirSync(join(root, "web"));
    expect(deriveProjectTool(root, "web", ["npx", "eslint"])?.paths).toEqual([
      "node_modules/.bin/eslint",
      "node_modules/eslint/**",
    ]);
  });

  it("takes a Python virtual environment's script, and a checkout file, as they are", () => {
    const root = tempDir();
    put(root, ".venv/bin/ruff", "binary", 0o755);
    expect(deriveProjectTool(root, "", ["uv", "run", "ruff", "check"])?.paths).toEqual([
      ".venv/bin/ruff",
    ]);
    put(root, "tools/lint.sh", "#!/bin/sh\n", 0o755);
    expect(deriveProjectTool(root, "", ["./tools/lint.sh"])?.paths).toEqual(["tools/lint.sh"]);
  });

  it("reads the value of a flag that takes one, and resolves from a -C directory", () => {
    const root = nodeProject();
    put(root, "web/node_modules/eslint/package.json", JSON.stringify({ name: "eslint" }));
    put(root, "web/node_modules/eslint/bin/eslint.js", "#!/usr/bin/env node\n", 0o755);
    link(root, "web/node_modules/.bin/eslint", "../eslint/bin/eslint.js");
    expect(
      deriveProjectTool(root, "", ["pnpm", "-C", "web", "exec", "eslint", "."])?.paths,
    ).toEqual(["web/node_modules/.bin/eslint", "web/node_modules/eslint/**"]);
    expect(deriveProjectTool(root, "", ["pnpm", "--dir=web", "exec", "eslint"])?.paths).toEqual([
      "web/node_modules/.bin/eslint",
      "web/node_modules/eslint/**",
    ]);
    // Other packages picked by name: what runs is not resolved from here.
    expect(deriveProjectTool(root, "", ["pnpm", "--filter", "web", "exec", "eslint"])).toBeNull();
    expect(deriveProjectTool(root, "", ["npm", "exec", "-w", "web", "eslint"])).toBeNull();
  });

  it("resolves a package script's commands to their tools", () => {
    const root = nodeProject();
    put(
      root,
      "package.json",
      JSON.stringify({
        scripts: {
          typecheck: "tsc --noEmit",
          lint: "NODE_OPTIONS=--max-old-space-size=4096 eslint . && tsc -p tsconfig.json",
          check: "pnpm run lint",
          docs: "node tools/docs.mjs",
        },
      }),
    );
    expect(deriveProjectTool(root, "", ["pnpm", "typecheck"])?.paths).toEqual([
      "node_modules/.bin/tsc",
      "node_modules/typescript/**",
    ]);
    const both = [
      "node_modules/.bin/eslint",
      "node_modules/eslint/**",
      "node_modules/.bin/tsc",
      "node_modules/typescript/**",
    ];
    expect(deriveProjectTool(root, "", ["npm", "run", "lint"])?.paths).toEqual(both);
    expect(deriveProjectTool(root, "", ["pnpm", "run", "check"])?.paths).toEqual(both);
    // A script that runs nothing installed in the checkout has no project tool.
    expect(deriveProjectTool(root, "", ["pnpm", "run", "docs"])).toBeNull();
    expect(deriveProjectTool(root, "", ["pnpm", "run", "absent"])).toBeNull();
  });

  it("derives nothing for a tool outside the checkout, a script name or a missing bin", () => {
    const root = nodeProject();
    expect(deriveProjectTool(root, "", [process.execPath, "tools/lint.mjs"])).toBeNull();
    expect(deriveProjectTool(root, "", ["pnpm", "run", "lint"])).toBeNull();
    expect(deriveProjectTool(root, "", ["pnpm", "exec", "prettier"])).toBeNull();
    expect(deriveProjectTool(root, "", ["go", "vet", "./..."])).toBeNull();
    // A link out of the checkout is not the project's tool.
    link(root, "node_modules/.bin/outside", "/usr/bin/true");
    expect(deriveProjectTool(root, "", ["npx", "outside"])).toBeNull();
  });
});
