/**
 * H-14 by a full dependency-tree diff (spine §5 reading 252): `workspaceTree` hashes every file
 * and link of the checkout without choosing which ones matter, `compareInstall` diffs what the
 * install phase's scripts did against it (only a package rebuilding itself in its own directory
 * is allowed), and `compareGate` what changed before a verify gate. Each review finding of
 * h14-open (round 7) is reproduced here on the file system, then end to end in
 * `tool-tamper.test.ts`.
 */
import { appendFileSync, chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareGate,
  compareInstall,
  inDependencyTree,
  ToolHashLimitError,
  WORKSPACE_HASH_LIMITS,
  workspaceTree,
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

const pkg = (name: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ name, version: "1.0.0", ...extra });

/** A pnpm shim as pnpm writes it: prefers `$basedir/node`, then starts `target`. */
const shim = (target: string): string =>
  `#!/bin/sh\nbasedir=$(dirname "$0")\nif [ -x "$basedir/node" ]; then\n  exec "$basedir/node" "$basedir/${target}" "$@"\nelse\n  exec node "$basedir/${target}" "$@"\nfi\n`;

const PNPM = "node_modules/.pnpm";
const VITEST = `${PNPM}/vitest@1.0.0/node_modules/vitest`;
const EXPECT = `${PNPM}/@vitest+expect@1.0.0/node_modules/@vitest/expect`;
const ESBUILD = `${PNPM}/esbuild@0.25.0/node_modules/esbuild`;
const SITE = ".venv/lib/python3.12/site-packages";

/**
 * A pnpm monorepo after a scripts-free install: vitest at the root (its dependency @vitest/expect
 * in the virtual store, its bin a pnpm shim), esbuild with a postinstall that rebuilds its own
 * binary, ts-jest and a babel preset for packages/web's jest, packages/app with no bin of its own,
 * and a Python virtual environment with pytest.
 */
const monorepo = (): string => {
  const root = tempDir("vtc-tree-");
  put(root, "package.json", pkg("root", { scripts: { test: "turbo run test" } }));
  put(root, "pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  put(root, "packages/app/package.json", pkg("app", { scripts: { test: "vitest run" } }));
  put(root, "packages/app/src/index.ts", "export const app = 1;\n");
  put(root, "packages/web/package.json", pkg("web", { jest: { preset: "ts-jest" } }));
  put(
    root,
    "packages/web/babel.config.js",
    "module.exports = { presets: ['@acme/babel-preset'] };\n",
  );
  put(root, `${VITEST}/package.json`, pkg("vitest", { dependencies: { "@vitest/expect": "1" } }));
  put(root, `${VITEST}/vitest.mjs`, "import '@vitest/expect';\n");
  link(
    root,
    `${PNPM}/vitest@1.0.0/node_modules/@vitest/expect`,
    "../../../@vitest+expect@1.0.0/node_modules/@vitest/expect",
  );
  put(root, `${EXPECT}/package.json`, pkg("@vitest/expect"));
  put(
    root,
    `${EXPECT}/index.js`,
    "export const expect = (v) => ({ toBe: (w) => { if (v !== w) throw new Error('no'); } });\n",
  );
  link(root, "node_modules/vitest", ".pnpm/vitest@1.0.0/node_modules/vitest");
  put(root, "node_modules/.bin/vitest", shim("../vitest/vitest.mjs"), 0o755);
  put(
    root,
    `${ESBUILD}/package.json`,
    pkg("esbuild", {
      scripts: { postinstall: "node install.js" },
      bin: { esbuild: "bin/esbuild" },
    }),
  );
  put(root, `${ESBUILD}/install.js`, "// rebuilds bin/esbuild\n");
  put(root, `${ESBUILD}/bin/esbuild`, "#!/usr/bin/env node\n// js fallback\n", 0o755);
  link(root, "node_modules/esbuild", ".pnpm/esbuild@0.25.0/node_modules/esbuild");
  put(
    root,
    "node_modules/.bin/esbuild",
    shim(`../.pnpm/esbuild@0.25.0/node_modules/esbuild/bin/esbuild`),
    0o755,
  );
  put(root, "node_modules/.modules.yaml", "pendingBuilds:\n  - esbuild@0.25.0\n");
  put(root, "packages/web/node_modules/ts-jest/package.json", pkg("ts-jest"));
  put(
    root,
    "packages/web/node_modules/ts-jest/jest-preset.js",
    "module.exports = { transform: {} };\n",
  );
  put(root, "packages/web/node_modules/@acme/babel-preset/package.json", pkg("@acme/babel-preset"));
  put(
    root,
    "packages/web/node_modules/@acme/babel-preset/index.js",
    "module.exports = () => ({ plugins: [] });\n",
  );
  put(root, ".venv/pyvenv.cfg", "home = /usr/bin\n");
  put(root, ".venv/bin/pytest", "#!/x/.venv/bin/python\nfrom pytest import console_main\n", 0o755);
  link(root, ".venv/bin/python", "/usr/bin/python3");
  put(root, `${SITE}/_pytest/assertion/rewrite.py`, "def rewrite(): ...\n");
  put(root, `${SITE}/pytest-8.0.0.dist-info/RECORD`, "_pytest/assertion/rewrite.py,,\n");
  put(root, ".git/HEAD", "ref: refs/heads/main\n");
  return root;
};

describe("workspaceTree: every file and link of the checkout, chosen by nothing", () => {
  it("hashes the dependency trees whole and the checkout's own files, never .git, never through a link", () => {
    const root = monorepo();
    const outside = tempDir();
    put(outside, "secret.txt", "host");
    link(root, "node_modules/leak", outside);
    put(root, ".yarn/unplugged/x-npm-1.0.0/node_modules/x/index.js", "x");
    put(root, ".pnp.cjs", "// pnp\n");
    const tree = workspaceTree(root);
    const paths = [...tree.snapshot.files.keys()];
    expect(paths).toContain(`${EXPECT}/index.js`);
    expect(paths).toContain(`${SITE}/_pytest/assertion/rewrite.py`);
    expect(paths).toContain("packages/web/node_modules/ts-jest/jest-preset.js");
    expect(paths).toContain(".yarn/unplugged/x-npm-1.0.0/node_modules/x/index.js");
    expect(paths).toContain(".pnp.cjs");
    expect(paths).toContain("packages/app/src/index.ts");
    expect(tree.snapshot.files.get(`${EXPECT}/index.js`)).toBe(
      sha(
        "export const expect = (v) => ({ toBe: (w) => { if (v !== w) throw new Error('no'); } });\n",
      ),
    );
    expect(tree.snapshot.files.get("node_modules/vitest")).toBe(
      "link:.pnpm/vitest@1.0.0/node_modules/vitest",
    );
    expect(tree.snapshot.files.get("node_modules/leak")).toBe(`link:${outside}`);
    expect(paths.some((p) => p.startsWith(".git/") || p.startsWith("node_modules/leak/"))).toBe(
      false,
    );
    expect(tree.venvs).toEqual([".venv"]);
    expect(tree.packages.get(ESBUILD)).toEqual({ installed: true, scripts: ["postinstall"] });
    expect(tree.packages.get("packages/app")).toEqual({ installed: false, scripts: [] });
    expect(tree.binOwners.get("node_modules/.bin/esbuild")).toBe(ESBUILD);
    expect(tree.binOwners.get("node_modules/.bin/vitest")).toBe(VITEST);
  });

  it("classifies the dependency trees, and leaves the rest as the checkout's own", () => {
    for (const path of [
      "node_modules/a/index.js",
      "packages/app/node_modules/.bin/vitest",
      ".yarn/cache/a.zip",
      ".pnp.loader.mjs",
      "__pypackages__/3.12/lib/x.py",
      ".venv/lib/python3.12/site-packages/x.py",
    ]) {
      expect(inDependencyTree(path, [".venv"]), path).toBe(true);
    }
    for (const path of ["src/index.ts", "packages/app/package.json", ".npmrc", "venv2/x.py"]) {
      expect(inDependencyTree(path, [".venv"]), path).toBe(false);
    }
  });

  it("keeps a file's line on the fast path only while its size, times and inode are unchanged", () => {
    const root = monorepo();
    const first = workspaceTree(root);
    const path = `${EXPECT}/index.js`;
    // a previous snapshot whose line differs but whose stat key matches is trusted as it is
    const forged = {
      ...first,
      snapshot: {
        ...first.snapshot,
        files: new Map([...first.snapshot.files].map(([p, h]) => [p, p === path ? "x" : h])),
      },
    };
    expect(workspaceTree(root, { previous: forged }).snapshot.files.get(path)).toBe("x");
    // any write changes the change time: the file is read again
    appendFileSync(join(root, path), "// off\n");
    expect(workspaceTree(root, { previous: forged }).snapshot.files.get(path)).not.toBe("x");
    expect(workspaceTree(root, { previous: first }).snapshot.files.get(path)).not.toBe(
      first.snapshot.files.get(path),
    );
  });

  it("refuses a checkout bigger than it hashes, rather than hashing part of it", () => {
    const root = monorepo();
    expect(() =>
      workspaceTree(root, { limits: { ...WORKSPACE_HASH_LIMITS, maxFiles: 5 } }),
    ).toThrow(ToolHashLimitError);
    expect(() =>
      workspaceTree(root, { limits: { ...WORKSPACE_HASH_LIMITS, maxBytes: 10 } }),
    ).toThrow(/checkout has more than 10 bytes/);
  });
});

describe("compareInstall: what the install phase's scripts did (reading 252)", () => {
  /** The monorepo's baseline, `scripts` run on it, and the comparison. */
  const install = (scripts: (root: string) => void, isProtected?: (path: string) => boolean) => {
    const root = monorepo();
    const before = workspaceTree(root);
    scripts(root);
    return compareInstall(before, workspaceTree(root), isProtected);
  };

  it("h14-task-runner-tool-unverified: a transitive dependency of the test runner, patched", () => {
    const result = install((root) => {
      put(root, `${EXPECT}/index.js`, "export const expect = () => ({ toBe: () => {} });\n");
    });
    expect(result.tampered).toEqual([`${EXPECT}/index.js`]);
    expect(result.selfRebuilt).toEqual([]);
  });

  it("h14-bin-dir-interpreter-hijack: a .bin directory the baseline did not have", () => {
    const result = install((root) => {
      put(root, "packages/app/node_modules/.bin/vitest", "#!/bin/sh\nexit 0\n", 0o755);
      put(root, "packages/app/node_modules/.bin/node", "#!/bin/sh\nexit 0\n", 0o755);
    });
    expect(result.tampered).toEqual([
      "packages/app/node_modules/.bin/node",
      "packages/app/node_modules/.bin/vitest",
    ]);
  });

  it("h14-runtime-derived-tool-misses-lint-plugins: a patched ts-jest preset and babel preset", () => {
    const result = install((root) => {
      put(
        root,
        "packages/web/node_modules/ts-jest/jest-preset.js",
        "module.exports = { testMatch: [] };\n",
      );
      put(
        root,
        "packages/web/node_modules/@acme/babel-preset/index.js",
        "module.exports = () => ({ plugins: ['strip-expect'] });\n",
      );
    });
    expect(result.tampered).toEqual([
      "packages/web/node_modules/@acme/babel-preset/index.js",
      "packages/web/node_modules/ts-jest/jest-preset.js",
    ]);
  });

  it("h14-task-runner-tool-unverified (Python): a patched _pytest file in the virtual environment", () => {
    const result = install((root) => {
      put(root, `${SITE}/_pytest/assertion/rewrite.py`, "def rewrite(): return None\n");
      put(root, `${SITE}/usercustomize.py`, "import sys\n");
    });
    expect(result.tampered).toEqual([
      `${SITE}/_pytest/assertion/rewrite.py`,
      `${SITE}/usercustomize.py`,
    ]);
  });

  it("allows an esbuild-style package to rebuild itself in its own directory, its .bin with it", () => {
    const result = install((root) => {
      put(root, `${ESBUILD}/bin/esbuild`, "\u007fELF native", 0o755);
      put(root, `${ESBUILD}/esbuild.node`, "native");
      // pnpm relinks a rebuilt package's bin (the interpreter changes with the binary)
      put(
        root,
        "node_modules/.bin/esbuild",
        shim("../esbuild/bin/esbuild").replace("/node", "/sh"),
        0o755,
      );
      put(root, "node_modules/.modules.yaml", "pendingBuilds: []\n");
    });
    expect(result.tampered).toEqual([]);
    expect(result.selfRebuilt).toEqual([
      {
        package: ESBUILD,
        files: ["node_modules/.bin/esbuild", `${ESBUILD}/bin/esbuild`, `${ESBUILD}/esbuild.node`],
      },
    ]);
    expect(result.managerState).toEqual(["node_modules/.modules.yaml"]);
  });

  it("fails that same package writing into another package, a new bin or its own package link", () => {
    const result = install((root) => {
      put(root, `${ESBUILD}/bin/esbuild`, "\u007fELF native", 0o755);
      put(root, `${EXPECT}/index.js`, "export const expect = () => ({ toBe: () => {} });\n");
      put(root, "node_modules/.bin/esbuild-helper", shim("../esbuild/bin/esbuild"), 0o755);
      put(root, `${ESBUILD}/node_modules/.bin/vitest`, "#!/bin/sh\nexit 0\n", 0o755);
      rmSync(join(root, "node_modules/esbuild"));
      link(root, "node_modules/esbuild", ".pnpm/vitest@1.0.0/node_modules/vitest");
    });
    expect(result.tampered).toEqual([
      "node_modules/.bin/esbuild-helper",
      `${EXPECT}/index.js`,
      `${ESBUILD}/node_modules/.bin/vitest`,
      "node_modules/esbuild",
    ]);
    expect(result.selfRebuilt).toEqual([{ package: ESBUILD, files: [`${ESBUILD}/bin/esbuild`] }]);
  });

  it("fails a package that declared no install script, or one it added during the scripts", () => {
    const result = install((root) => {
      put(root, `${VITEST}/package.json`, pkg("vitest", { scripts: { postinstall: "x" } }));
      put(root, `${VITEST}/native.node`, "x");
    });
    expect(result.tampered).toEqual([`${VITEST}/native.node`, `${VITEST}/package.json`]);
  });

  it("lets one of the checkout's own packages with an install script add build outputs, never configs or tracked files", () => {
    const protectedPath = (path: string): boolean => /(^|\/)vitest\.config\.\w+$/.test(path);
    const result = install((root) => {
      put(root, "packages/app/package.json", pkg("app", { scripts: { prepare: "tsc" } }));
    }, protectedPath);
    // the baseline had no prepare script: the change itself is tampering
    expect(result.tampered).toEqual(["packages/app/package.json"]);

    const root = monorepo();
    put(root, "packages/app/package.json", pkg("app", { scripts: { prepare: "tsc" } }));
    const before = workspaceTree(root);
    put(root, "packages/app/dist/index.js", "built");
    put(root, "packages/app/vitest.config.ts", "export default { test: { include: [] } };\n");
    put(root, "packages/app/src/index.ts", "export const app = 2;\n");
    put(root, "packages/web/dist/index.js", "not app's");
    put(root, ".npmrc", "node-options=--require=./p.cjs\n");
    const compared = compareInstall(before, workspaceTree(root), protectedPath);
    expect(compared.selfRebuilt).toEqual([
      { package: "packages/app", files: ["packages/app/dist/index.js"] },
    ]);
    expect(compared.tampered).toEqual([
      ".npmrc",
      "packages/app/src/index.ts",
      "packages/app/vitest.config.ts",
      "packages/web/dist/index.js",
    ]);
  });

  it("finds nothing when the scripts changed nothing", () => {
    const result = install(() => undefined);
    expect(result).toEqual({ tampered: [], selfRebuilt: [], managerState: [] });
  });
});

describe("compareGate: what changed before a verify gate (reading 252)", () => {
  it("allows the tools' caches and new build outputs, and fails everything else", () => {
    const root = monorepo();
    put(root, "packages/app/dist/index.js", "from the install's prepare");
    const after = workspaceTree(root);
    put(root, "node_modules/.vite/vitest/results.json", "{}");
    put(root, `${SITE}/_pytest/__pycache__/rewrite.cpython-312.pyc`, "pyc");
    put(root, "packages/app/coverage/lcov.info", "TN:");
    put(root, "packages/app/dist/index.js", "rebuilt by the build gate");
    put(root, "tests/acceptance/hidden.json", "[]");
    put(root, `${EXPECT}/index.js`, "export const expect = () => ({ toBe: () => {} });\n");
    put(root, "packages/app/node_modules/.bin/vitest", "#!/bin/sh\nexit 0\n", 0o755);
    put(root, "packages/app/vitest.config.ts", "export default {};\n");
    put(root, "packages/app/src/index.ts", "export const app = 3;\n");
    const now = workspaceTree(root, { previous: after });
    expect(
      compareGate(after, now, {
        isProtected: (p) => p.endsWith("vitest.config.ts"),
        ignore: (p) => p === "tests/acceptance/hidden.json",
        mayChange: new Set(["packages/app/dist/index.js"]),
      }),
    ).toEqual([
      `${EXPECT}/index.js`,
      "packages/app/node_modules/.bin/vitest",
      "packages/app/src/index.ts",
      "packages/app/vitest.config.ts",
    ]);
  });
});
