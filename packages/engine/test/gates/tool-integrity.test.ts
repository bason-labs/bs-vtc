/**
 * Check-tool integrity (H-14; spine §5 readings 80(c) and 238): the scripts-free form of an
 * install command, the content hash of a tool's files, what changed between two hashes, and the
 * `project` tool derived from a gate command's executable.
 */
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  changedToolFiles,
  deriveProjectTool,
  hashTool,
  scriptsFreeInstall,
  TOOL_HASH_LIMITS,
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

describe("scriptsFreeInstall: the install that runs no lifecycle script", () => {
  it("adds the package manager's own switch and runs the install again for its scripts", () => {
    expect(scriptsFreeInstall(["npm", "ci"])).toEqual({
      argv: ["npm", "ci", "--ignore-scripts"],
      rerun: true,
    });
    expect(scriptsFreeInstall(["/usr/local/bin/pnpm", "install", "--frozen-lockfile"])).toEqual({
      argv: ["/usr/local/bin/pnpm", "install", "--frozen-lockfile", "--ignore-scripts"],
      rerun: true,
    });
    expect(scriptsFreeInstall(["bun", "install", "--frozen-lockfile"])?.argv).toEqual([
      "bun",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
    // Yarn Berry builds in a mode of its own; Yarn Classic takes --ignore-scripts.
    expect(scriptsFreeInstall(["yarn", "install", "--immutable"])?.argv).toEqual([
      "yarn",
      "install",
      "--immutable",
      "--mode=skip-build",
    ]);
    expect(scriptsFreeInstall(["yarn", "install", "--frozen-lockfile"])?.argv).toEqual([
      "yarn",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ]);
  });

  it("takes an install that runs no project code as it is, once", () => {
    expect(scriptsFreeInstall(["go", "mod", "download"])).toEqual({
      argv: ["go", "mod", "download"],
      rerun: false,
    });
    expect(scriptsFreeInstall(["cargo", "fetch", "--locked"])).toEqual({
      argv: ["cargo", "fetch", "--locked"],
      rerun: false,
    });
    expect(scriptsFreeInstall(["npm", "ci", "--ignore-scripts"])).toEqual({
      argv: ["npm", "ci", "--ignore-scripts"],
      rerun: false,
    });
  });

  it("knows no scripts-free form of any other command", () => {
    expect(scriptsFreeInstall(["uv", "sync", "--frozen"])).toBeNull();
    expect(scriptsFreeInstall(["npm", "run", "setup"])).toBeNull();
    expect(scriptsFreeInstall(["node", "tools/install.mjs"])).toBeNull();
    expect(scriptsFreeInstall(["yarn", "install", "--mode=update-lockfile"])).toBeNull();
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
