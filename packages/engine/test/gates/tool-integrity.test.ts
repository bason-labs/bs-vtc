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
  lintPluginPaths,
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
    // A second pnpm install leaves the pending builds; a recursive `pnpm rebuild --pending` runs
    // them in every workspace project, not the root project only.
    expect(scriptsFreeInstall(["/usr/local/bin/pnpm", "install", "--frozen-lockfile"])).toEqual({
      free: ["/usr/local/bin/pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      build: ["/usr/local/bin/pnpm", "rebuild", "--recursive", "--pending"],
    });
    // A second plain bun install of a workspace skips its packages' dependency scripts.
    expect(scriptsFreeInstall(["bun", "install", "--frozen-lockfile"])).toEqual({
      free: ["bun", "install", "--frozen-lockfile", "--ignore-scripts"],
      build: ["bun", "install", "--frozen-lockfile", "--force"],
    });
  });

  it("rebuilds where a pnpm install ran, and makes no two passes of one that picks projects", () => {
    expect(scriptsFreeInstall(["pnpm", "-C", "app", "install", "--frozen-lockfile"])).toEqual({
      free: ["pnpm", "-C", "app", "install", "--frozen-lockfile", "--ignore-scripts"],
      build: ["pnpm", "-C", "app", "rebuild", "--recursive", "--pending"],
    });
    expect(scriptsFreeInstall(["pnpm", "install", "--dir=app"])?.build).toEqual([
      "pnpm",
      "--dir",
      "app",
      "rebuild",
      "--recursive",
      "--pending",
    ]);
    expect(scriptsFreeInstall(["pnpm", "install", "--filter", "a"])).toBeNull();
    expect(scriptsFreeInstall(["pnpm", "--filter=a", "install"])).toBeNull();
    expect(scriptsFreeInstall(["pnpm", "-F", "a", "i"])).toBeNull();
    expect(scriptsFreeInstall(["pnpm", "add", "lint"])).toBeNull();
    expect(scriptsFreeInstall(["pnpm", "install", "-C"])).toBeNull();
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

  it("takes a shim's script, never the `$basedir/node` interpreter it prefers (reading 249)", () => {
    const root = tempDir();
    put(root, "node_modules/eslint/package.json", JSON.stringify({ name: "eslint" }));
    put(root, "node_modules/eslint/bin/eslint.js", "lint");
    // the shim pnpm and cmd-shim write: `$basedir/node` first when it exists
    put(
      root,
      "node_modules/.bin/eslint",
      '#!/bin/sh\nbasedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node"  "$basedir/../eslint/bin/eslint.js" "$@"\nelse\n  exec node  "$basedir/../eslint/bin/eslint.js" "$@"\nfi\n',
      0o755,
    );
    const paths = ["node_modules/.bin/eslint", "node_modules/eslint/**"];
    expect(deriveProjectTool(root, "", ["pnpm", "exec", "eslint", "."])?.paths).toEqual(paths);
    // a planted interpreter beside the shim does not shrink the derived tool to the shim alone
    put(root, "node_modules/.bin/node", "#!/bin/sh\nexit 0\n", 0o755);
    expect(deriveProjectTool(root, "", ["pnpm", "exec", "eslint", "."])?.paths).toEqual(paths);
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

describe("lintPluginPaths: what a lint config loads besides ESLint (reading 249)", () => {
  it("adds the packages the lint config imports and the plugins the package.json lists", () => {
    const root = tempDir();
    put(
      root,
      "package.json",
      JSON.stringify({ devDependencies: { "eslint-plugin-x": "1", "@eslint/js": "1", left: "1" } }),
    );
    put(
      root,
      "eslint.config.mjs",
      'import js from "@eslint/js";\nimport globals from "globals";\nimport sub from "pkg-a/sub";\nimport local from "./local.js";\nconst r = require("@scope/cfg/x");\nexport default [];\n',
    );
    for (const pkg of ["eslint-plugin-x", "@eslint/js", "globals", "pkg-a", "@scope/cfg", "left"])
      put(root, `node_modules/${pkg}/package.json`, JSON.stringify({ name: pkg }));
    expect(lintPluginPaths(root, "").sort()).toEqual([
      "node_modules/@eslint/js/**",
      "node_modules/@scope/cfg/**",
      "node_modules/eslint-plugin-x/**",
      "node_modules/globals/**",
      "node_modules/pkg-a/**",
    ]);
  });
});
