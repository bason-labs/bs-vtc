/**
 * H-14 by a full dependency-tree diff (spine §5 readings 252 and 253): `workspaceTree` hashes
 * every file and link of the checkout without choosing which ones matter, and fails closed on what
 * it cannot list, read or vouch for; `compareInstall` diffs what one writer's install scripts did
 * against it (only a package rebuilding itself in its own directory is allowed, and only to that
 * package's own scripts), and `compareGate` what changed before a verify gate; `perPackageBuild`
 * runs the scripts one writer at a time. Each review finding of h14-open (round 7) and h14-open2
 * is reproduced here on the file system, then end to end in `tool-tamper.test.ts`.
 */
import { appendFileSync, chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  committedDependencyFiles,
  compareGate,
  compareInstall,
  inDependencyTree,
  perPackageBuild,
  sharedInstallNames,
  ToolHashLimitError,
  unverifiedSharedNames,
  WORKSPACE_HASH_LIMITS,
  workspaceTree as walk,
  type WorkspaceTree,
} from "../../src/gates/tool-integrity.js";
import { matchesAnyCaseless } from "../../src/gates/globs.js";
import { DEFAULT_PROTECTED_GLOBS } from "../../src/gates/protected-globs.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

/** Directories a test made unlistable, made listable again before they are removed. */
const locked: string[] = [];

afterEach(() => {
  for (const dir of locked.splice(0)) chmodSync(dir, 0o755);
  cleanupDirs();
});

/** Whether permissions bind this process (root reads and lists anything). */
const permissionsBind = process.getuid?.() !== 0;

/** The run's private root, which gate commands can write: none of the fixtures' links lead there. */
const JAIL = "/private/var/vtc-test-jail-that-does-not-exist";

/** The checkout's snapshot, with the gate sandbox's writable directories (`JAIL`) given. */
const workspaceTree = (root: string, options: Parameters<typeof walk>[1] = {}): WorkspaceTree =>
  walk(root, { writable: [JAIL], ...options });

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
    expect(tree.packages.get(ESBUILD)).toEqual({
      installed: true,
      scripts: ["postinstall"],
      name: "esbuild",
      version: "1.0.0",
      pnpmSettings: false,
      registry: false,
    });
    expect(tree.packages.get("packages/app")).toEqual({
      installed: false,
      scripts: [],
      name: "app",
      version: "1.0.0",
      pnpmSettings: false,
      registry: false,
    });
    expect(tree.refused).toEqual([]);
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
  /** The monorepo's baseline, `scripts` of `writer` run on it, and the comparison. */
  const install = (
    scripts: (root: string) => void,
    isProtected?: (path: string) => boolean,
    writer: Parameters<typeof compareInstall>[3] = { dependency: "esbuild" },
  ) => {
    const root = monorepo();
    const before = workspaceTree(root);
    scripts(root);
    return compareInstall(before, workspaceTree(root), isProtected, writer);
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
    const compared = compareInstall(before, workspaceTree(root), protectedPath, {
      project: "packages/app",
    });
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

describe("h14-unlistable-dir-hidden-from-tree: nothing is skipped silently (reading 253)", () => {
  /** Makes `rel` execute-only (0111): looked up and run by path, never listed. */
  const lock = (root: string, rel: string, mode = 0o111): void => {
    chmodSync(join(root, rel), mode);
    locked.push(join(root, rel));
  };

  it.skipIf(!permissionsBind)(
    "a .bin planted after the baseline and made execute-only is tampering for compareInstall and compareGate",
    () => {
      // the finding's reproduction: packages/app has node_modules but no .bin in the baseline
      const root = tempDir("vtc-tree-");
      put(root, "package.json", pkg("root"));
      put(root, "packages/app/package.json", pkg("app", { scripts: { test: "vitest run" } }));
      put(root, "packages/app/node_modules/dep/package.json", pkg("dep"));
      const before = workspaceTree(root);
      put(root, "packages/app/node_modules/.bin/tool", "#!/bin/sh\nexit 0\n", 0o755);
      lock(root, "packages/app/node_modules/.bin");
      const after = workspaceTree(root);
      expect(after.refused).toEqual(["packages/app/node_modules/.bin"]);
      expect(after.snapshot.files.get("packages/app/node_modules/.bin")).toBe("refused:unreadable");
      for (const writer of [{ dependency: "dep" }, { project: "packages/app" }, null]) {
        expect(compareInstall(before, after, undefined, writer).tampered).toEqual([
          "packages/app/node_modules/.bin",
        ]);
      }
      expect(compareGate(before, after)).toEqual(["packages/app/node_modules/.bin"]);
      // and still on every later snapshot, changed or not
      expect(compareGate(after, workspaceTree(root, { previous: after }))).toEqual([
        "packages/app/node_modules/.bin",
      ]);
    },
  );

  it.skipIf(!permissionsBind)(
    "a shadow package in a new execute-only node_modules directory, under an installed package's own directory",
    () => {
      const root = monorepo();
      const before = workspaceTree(root);
      put(root, `${ESBUILD}/node_modules/vitest/index.js`, "export {};\n");
      lock(root, `${ESBUILD}/node_modules`);
      // even esbuild's own step may not hide a directory in its own tree
      expect(
        compareInstall(before, workspaceTree(root), undefined, { dependency: "esbuild" }),
      ).toEqual({ tampered: [`${ESBUILD}/node_modules`], selfRebuilt: [], managerState: [] });
    },
  );

  it.skipIf(!permissionsBind)(
    "a directory listed but not searchable, and a file not readable, are refused lines too",
    () => {
      const root = monorepo();
      const before = workspaceTree(root);
      put(root, "packages/app/lib/a.js", "a");
      lock(root, "packages/app/lib", 0o444);
      put(root, `${EXPECT}/extra.js`, "x", 0o000);
      locked.push(join(root, `${EXPECT}/extra.js`));
      const after = workspaceTree(root);
      expect(after.refused).toEqual([`${EXPECT}/extra.js`, "packages/app/lib/a.js"]);
      expect(
        compareInstall(before, after, undefined, { project: "packages/app" }).tampered,
      ).toEqual([`${EXPECT}/extra.js`, "packages/app/lib/a.js"]);
    },
  );

  it.skipIf(!permissionsBind)("a baseline that cannot be listed whole says so", () => {
    const root = monorepo();
    put(root, "packages/web/node_modules/.cache/x", "x");
    lock(root, "packages/web/node_modules/.cache");
    // the runner then runs no verify gate (infra): nothing after it could be told apart
    expect(workspaceTree(root).refused).toEqual(["packages/web/node_modules/.cache"]);
  });
});

describe("h14-self-rebuild-allowance-not-attributed-to-writer: allowed by who wrote it (reading 253)", () => {
  const MAIN = `${ESBUILD}/lib/main.js`;

  /** The monorepo with esbuild's JavaScript API, its baseline, `scripts`, and the comparison. */
  const step = (writer: Parameters<typeof compareInstall>[3], scripts: (root: string) => void) => {
    const root = monorepo();
    put(root, MAIN, "export const transform = (code) => code;\n");
    const before = workspaceTree(root);
    scripts(root);
    return compareInstall(before, workspaceTree(root), undefined, writer);
  };
  const dropAssertions = (root: string): void => {
    put(root, MAIN, "export const transform = (code) => code.replace(/expect\\(/g, 'void (');\n");
  };

  it("the checkout's own postinstall rewriting esbuild's lib/main.js is tampering", () => {
    expect(step({ project: "" }, dropAssertions)).toEqual({
      tampered: [MAIN],
      selfRebuilt: [],
      managerState: [],
    });
  });

  it("so is another dependency's script, and a scripts pass that ran all at once", () => {
    expect(step({ dependency: "vitest" }, dropAssertions).tampered).toEqual([MAIN]);
    expect(step(null, dropAssertions).tampered).toEqual([MAIN]);
    // with no writer named, not even a native rebuild is allowed
    expect(
      step(null, (root) => {
        put(root, `${ESBUILD}/bin/esbuild`, "\u007fELF native", 0o755);
      }).tampered,
    ).toEqual([`${ESBUILD}/bin/esbuild`]);
  });

  it("not even esbuild's own script may change its JavaScript (reading 254(2))", () => {
    expect(step({ dependency: "esbuild" }, dropAssertions)).toEqual({
      tampered: [MAIN],
      selfRebuilt: [],
      managerState: [],
    });
  });

  it("a dependency's script may not add a file of the checkout's own", () => {
    expect(
      step({ dependency: "esbuild" }, (root) => {
        put(root, "packages/app/dist/index.js", "built");
      }).tampered,
    ).toEqual(["packages/app/dist/index.js"]);
  });
});

describe("perPackageBuild: the scripts pass one writer at a time (reading 253)", () => {
  it("pnpm: each pending dependency on its own, then each project's own scripts", () => {
    const root = monorepo();
    put(root, "package.json", pkg("root", { scripts: { postinstall: "node setup.js" } }));
    put(
      root,
      "packages/app/package.json",
      pkg("app", { scripts: { prepare: "tsc", install: "x" } }),
    );
    put(
      root,
      "node_modules/.modules.yaml",
      "layoutVersion: 5\npendingBuilds:\n  - packages/app\n  - .\n  - esbuild@0.25.0\n  - '@swc/core@1.3.0(@swc/helpers@0.5.0)'\n  - packages/web\nprunedAt: x\n",
    );
    expect(
      perPackageBuild(["pnpm", "install", "--frozen-lockfile"], root, "", workspaceTree(root)),
    ).toEqual([
      // by name and version (spine §5 reading 255), never by name alone where pnpm can
      {
        argv: ["pnpm", "rebuild", "--recursive", "@swc/core@1.3.0"],
        writer: { dependency: "@swc/core", version: "1.3.0" },
      },
      {
        argv: ["pnpm", "rebuild", "--recursive", "esbuild@0.25.0"],
        writer: { dependency: "esbuild", version: "0.25.0" },
      },
      {
        argv: [
          "pnpm",
          "--config.enable-pre-post-scripts=false",
          "--dir",
          ".",
          "run",
          "postinstall",
        ],
        writer: { project: "" },
      },
      {
        argv: [
          "pnpm",
          "--config.enable-pre-post-scripts=false",
          "--dir",
          "packages/app",
          "run",
          "install",
        ],
        writer: { project: "packages/app" },
      },
      {
        argv: [
          "pnpm",
          "--config.enable-pre-post-scripts=false",
          "--dir",
          "packages/app",
          "run",
          "prepare",
        ],
        writer: { project: "packages/app" },
      },
    ]);
  });

  it("pnpm: keeps the install's directory, and knows no steps without pendingBuilds", () => {
    const root = monorepo();
    put(root, "packages/app/node_modules/.modules.yaml", "pendingBuilds: []\n");
    expect(
      perPackageBuild(["pnpm", "-C", "app", "install"], root, "packages", workspaceTree(root)),
    ).toEqual([]);
    rmSync(join(root, "node_modules/.modules.yaml"));
    expect(perPackageBuild(["pnpm", "install"], root, "", workspaceTree(root))).toBeNull();
    put(root, "node_modules/.modules.yaml", "pendingBuilds:\n  - --inject@1.0.0\n");
    expect(perPackageBuild(["pnpm", "install"], root, "", workspaceTree(root))).toBeNull();
  });

  it("npm: each installed package with an install script, then the workspaces and the root", () => {
    const root = tempDir("vtc-npm-");
    put(
      root,
      "package.json",
      pkg("root", { workspaces: ["packages/*"], scripts: { prepare: "husky", postinstall: "x" } }),
    );
    put(root, "packages/a/package.json", pkg("a", { scripts: { postinstall: "x", prepare: "y" } }));
    put(root, "packages/b/package.json", pkg("b"));
    put(
      root,
      "node_modules/esbuild/package.json",
      pkg("esbuild", { scripts: { postinstall: "x" } }),
    );
    put(
      root,
      "node_modules/x/node_modules/esbuild/package.json",
      pkg("esbuild", { scripts: { install: "x" } }),
    );
    put(root, "node_modules/native/package.json", pkg("native"));
    put(root, "node_modules/native/binding.gyp", "{}");
    put(root, "node_modules/plain/package.json", pkg("plain"));
    // by location, never by name (reading 254(1)): `npm rebuild esbuild` would run both
    expect(perPackageBuild(["npm", "ci"], root, "", workspaceTree(root))).toEqual([
      {
        argv: ["npm", "rebuild", "./node_modules/esbuild"],
        writer: { installed: "node_modules/esbuild" },
      },
      {
        argv: ["npm", "rebuild", "./node_modules/native"],
        writer: { installed: "node_modules/native" },
      },
      {
        argv: ["npm", "rebuild", "./node_modules/x/node_modules/esbuild"],
        writer: { installed: "node_modules/x/node_modules/esbuild" },
      },
      {
        argv: ["npm", "--prefix", "packages/a", "run", "--ignore-scripts", "postinstall"],
        writer: { project: "packages/a" },
      },
      { argv: ["npm", "run", "--ignore-scripts", "postinstall"], writer: { project: "" } },
      { argv: ["npm", "run", "--ignore-scripts", "prepare"], writer: { project: "" } },
    ]);
    expect(
      perPackageBuild(["npm", "ci", "--workspace", "a"], root, "", workspaceTree(root)),
    ).toBeNull();
  });

  it("Bun, and an install with no second pass, have no per-package form", () => {
    const root = monorepo();
    expect(perPackageBuild(["bun", "install"], root, "", workspaceTree(root))).toBeNull();
    expect(
      perPackageBuild(["npm", "ci", "--ignore-scripts"], root, "", workspaceTree(root)),
    ).toBeNull();
    expect(perPackageBuild(["yarn", "install"], root, "", workspaceTree(root))).toBeNull();
  });
});

describe("h14-shared-download-cache-unhashed: Go's and Cargo's caches are hashed (reading 253)", () => {
  const ASSERT = "github.com/stretchr/testify@v1.9.0/assert/assertions.go";
  const CRATE = "index.crates.io-6f17d22bba15001f/pretty_assertions-1.4.0/src/lib.rs";

  /** A checkout and a run's download caches after the scripts-free `go mod download` and `cargo fetch`. */
  const fetched = () => {
    const root = monorepo();
    const deps = tempDir("vtc-deps-");
    put(deps, `go-mod/${ASSERT}`, "func Equal() bool { return check() }\n");
    put(deps, "go-mod/cache/download/github.com/stretchr/testify/@v/v1.9.0.lock", "");
    put(deps, `cargo-registry/src/${CRATE}`, "pub fn assert_eq() {}\n");
    put(deps, "cargo-git/checkouts/x-1234/abc/src/lib.rs", "pub fn x() {}\n");
    const caches = [
      { label: "go-mod", dir: join(deps, "go-mod"), skip: ["cache"] },
      { label: "cargo-registry/src", dir: join(deps, "cargo-registry/src") },
      { label: "cargo-git/checkouts", dir: join(deps, "cargo-git/checkouts") },
      { label: "missing", dir: join(deps, "nothing-here") },
    ];
    return { root, deps, caches, before: workspaceTree(root, { caches }) };
  };

  it("hashes the extracted contents under .vtc-deps, never Go's own download cache", () => {
    const { before } = fetched();
    expect([...before.snapshot.files.keys()].filter((p) => p.startsWith(".vtc-deps/"))).toEqual([
      `.vtc-deps/cargo-git/checkouts/x-1234/abc/src/lib.rs`,
      `.vtc-deps/cargo-registry/src/${CRATE}`,
      `.vtc-deps/go-mod/${ASSERT}`,
    ]);
  });

  it("a postinstall patching a Go or Rust assertion library is tampering, before a gate too", () => {
    const { root, deps, caches, before } = fetched();
    put(deps, `go-mod/${ASSERT}`, "func Equal() bool { return true }\n");
    put(deps, `cargo-registry/src/${CRATE}`, "pub fn assert_eq() { /* nothing */ }\n");
    put(deps, "go-mod/cache/download/github.com/stretchr/testify/@v/v1.9.0.lock", "held");
    const after = workspaceTree(root, { caches });
    expect(compareInstall(before, after, undefined, { dependency: "esbuild" }).tampered).toEqual([
      `.vtc-deps/cargo-registry/src/${CRATE}`,
      `.vtc-deps/go-mod/${ASSERT}`,
    ]);
    expect(compareGate(before, after)).toEqual([
      `.vtc-deps/cargo-registry/src/${CRATE}`,
      `.vtc-deps/go-mod/${ASSERT}`,
    ]);
  });

  it("the checkout's own .vtc-deps is refused, so it never collides with a cache's lines", () => {
    const { root, caches } = fetched();
    put(root, `.vtc-deps/go-mod/${ASSERT}`, "func Equal() bool { return true }\n");
    expect(workspaceTree(root, { caches }).refused).toEqual([".vtc-deps"]);
  });
});

describe("h14-links-out-of-checkout-not-followed: links out fail closed (reading 253)", () => {
  it("a link into a directory gate commands can write is refused; one to a system path is a line", () => {
    const root = monorepo();
    const jail = tempDir("vtc-jail-");
    put(jail, "home/.local/share/pnpm/store/v10/links/vitest/index.js", "export {};\n");
    link(
      root,
      "node_modules/.pnpm/vitest@2.0.0",
      join(jail, "home/.local/share/pnpm/store/v10/links/vitest"),
    );
    link(root, "node_modules/later", join(jail, "home/not-yet/there"));
    link(root, "node_modules/hop", "../node_modules/.pnpm/vitest@2.0.0");
    const tree = walk(root, { writable: [jail] });
    expect(tree.refused).toEqual([
      "node_modules/.pnpm/vitest@2.0.0",
      "node_modules/hop",
      "node_modules/later",
    ]);
    expect(tree.snapshot.files.get("node_modules/later")).toBe(
      `refused:link-out:${join(jail, "home/not-yet/there")}`,
    );
    // the virtual environment's interpreter is outside every writable directory
    expect(tree.snapshot.files.get(".venv/bin/python")).toBe("link:/usr/bin/python3");
    // by default every directory is writable: any link out of the checkout is refused
    expect(walk(root).refused).toContain(".venv/bin/python");
  });

  it("a link out created by an install script is tampering, whoever wrote it", () => {
    const root = monorepo();
    const jail = tempDir("vtc-jail-");
    const before = walk(root, { writable: [jail] });
    link(root, `${ESBUILD}/lib`, join(jail, "home/lib"));
    expect(
      compareInstall(before, walk(root, { writable: [jail] }), undefined, { dependency: "esbuild" })
        .tampered,
    ).toEqual([`${ESBUILD}/lib`]);
  });

  it("pnpm-workspace.yaml and a package.json with pnpm settings are protected configs", () => {
    const root = monorepo();
    rmSync(join(root, "pnpm-workspace.yaml"));
    const before = workspaceTree(root);
    put(root, "pnpm-workspace.yaml", "enableGlobalVirtualStore: true\n");
    put(root, "packages/app/tools/package.json", pkg("tools", { pnpm: { overrides: {} } }));
    put(root, "packages/app/dist/index.js", "built");
    put(root, "packages/app/Pnpm-Workspace.yaml", "packages: []\n");
    const after = workspaceTree(root);
    const expected = [
      "packages/app/Pnpm-Workspace.yaml",
      "packages/app/tools/package.json",
      "pnpm-workspace.yaml",
    ];
    expect(compareGate(before, after)).toEqual(expected);
    // packages/app's own script may add its build outputs, never pnpm's configuration
    expect(compareInstall(before, after, undefined, { project: "packages/app" })).toEqual({
      tampered: expected,
      selfRebuilt: [{ package: "packages/app", files: ["packages/app/dist/index.js"] }],
      managerState: [],
    });
  });
});

describe("h14-open3: a self-rebuild is one installed directory's, never a name's (reading 254)", () => {
  const isProtected = (path: string): boolean => matchesAnyCaseless(DEFAULT_PROTECTED_GLOBS, path);
  const MAIN_JS = "export const transform = (code) => code;\n";
  const PATCHED = "export const transform = (code) => code.replace(/expect\\(/g, 'void (');\n";
  /** esbuild as published: a postinstall, its JS fallback binary and its JavaScript API. */
  const esbuildAt = (root: string, dir: string, version = "0.25.0"): void => {
    put(
      root,
      `${dir}/package.json`,
      JSON.stringify({
        name: "esbuild",
        version,
        scripts: { postinstall: "node install.js" },
        bin: { esbuild: "bin/esbuild" },
      }),
    );
    put(root, `${dir}/install.js`, "// rebuilds bin/esbuild\n");
    put(root, `${dir}/bin/esbuild`, "#!/usr/bin/env node\n// js fallback\n", 0o755);
    put(root, `${dir}/lib/main.js`, MAIN_JS);
  };

  it("npm: the second esbuild's postinstall patching the first's lib/main.js is tampering", () => {
    // the finding's reproduction: a helper from a committed tarball depending on its own esbuild
    const root = tempDir("vtc-npm-");
    put(root, "package.json", pkg("app"));
    esbuildAt(root, "node_modules/esbuild");
    put(root, "node_modules/helper/package.json", pkg("helper"));
    esbuildAt(root, "node_modules/helper/node_modules/esbuild", "0.0.1");
    const tree = workspaceTree(root);
    expect(sharedInstallNames(tree)).toEqual(
      new Map([["esbuild", ["node_modules/esbuild", "node_modules/helper/node_modules/esbuild"]]]),
    );
    const steps = perPackageBuild(["npm", "ci"], root, "", tree);
    expect(steps).toEqual([
      {
        argv: ["npm", "rebuild", "./node_modules/esbuild"],
        writer: { installed: "node_modules/esbuild" },
      },
      {
        argv: ["npm", "rebuild", "./node_modules/helper/node_modules/esbuild"],
        writer: { installed: "node_modules/helper/node_modules/esbuild" },
      },
    ]);
    // the real esbuild's own step: npm rebuilt it by location, so its binary is its own even
    // though its name is shared (spine §5 reading 255)
    const real = workspaceTree(root);
    put(root, "node_modules/esbuild/bin/esbuild", "\u007fELF native", 0o755);
    const afterReal = workspaceTree(root);
    expect(compareInstall(tree, afterReal, isProtected, steps?.[0]?.writer ?? null)).toEqual({
      tampered: [],
      selfRebuilt: [
        { package: "node_modules/esbuild", files: ["node_modules/esbuild/bin/esbuild"] },
      ],
      managerState: [],
    });
    expect(real.snapshot.sha256).toBe(tree.snapshot.sha256);
    // the second esbuild's step patching the first one's JavaScript API
    put(root, "node_modules/esbuild/lib/main.js", PATCHED);
    expect(
      compareInstall(afterReal, workspaceTree(root), isProtected, steps?.[1]?.writer ?? null),
    ).toEqual({
      tampered: ["node_modules/esbuild/lib/main.js"],
      selfRebuilt: [],
      managerState: [],
    });
  });

  it("pnpm with onlyBuiltDependencies [esbuild]: both pending, one rebuild by name, and every change under either is tampering", () => {
    const root = tempDir("vtc-pnpm-");
    put(root, "package.json", pkg("app", { pnpm: { onlyBuiltDependencies: ["esbuild"] } }));
    const REAL = "node_modules/.pnpm/esbuild@file+vendor+esbuild-1.0.0.tgz/node_modules/esbuild";
    const FAKE = "node_modules/.pnpm/esbuild@file+..+vendor+esbuild-0.0.1.tgz/node_modules/esbuild";
    esbuildAt(root, REAL, "1.0.0");
    esbuildAt(root, FAKE, "0.0.1");
    link(
      root,
      "node_modules/esbuild",
      `.pnpm/esbuild@file+vendor+esbuild-1.0.0.tgz/node_modules/esbuild`,
    );
    put(
      root,
      "node_modules/.modules.yaml",
      "pendingBuilds:\n  - esbuild@file:vendor/esbuild-1.0.0.tgz\n  - esbuild@file:../vendor/esbuild-0.0.1.tgz\n",
    );
    const before = workspaceTree(root);
    const steps = perPackageBuild(["pnpm", "install", "--frozen-lockfile"], root, "", before);
    expect(steps).toEqual([
      { argv: ["pnpm", "rebuild", "--recursive", "esbuild"], writer: { dependency: "esbuild" } },
    ]);
    put(root, `${REAL}/bin/esbuild`, "\u007fELF native", 0o755);
    put(root, `${REAL}/lib/main.js`, PATCHED);
    put(root, `${FAKE}/bin/esbuild`, "\u007fELF native", 0o755);
    put(root, "node_modules/.modules.yaml", "pendingBuilds: []\n");
    expect(
      compareInstall(before, workspaceTree(root), isProtected, { dependency: "esbuild" }),
    ).toEqual({
      tampered: [`${FAKE}/bin/esbuild`, `${REAL}/bin/esbuild`, `${REAL}/lib/main.js`],
      selfRebuilt: [],
      managerState: ["node_modules/.modules.yaml"],
    });
  });

  it("a package installed under another folder name still shares the name in its package.json", () => {
    const root = tempDir("vtc-npm-");
    put(root, "package.json", pkg("app"));
    esbuildAt(root, "node_modules/esbuild");
    // `"evil": "file:esbuild-0.0.1.tgz"`: npm installs it as node_modules/evil
    esbuildAt(root, "node_modules/evil", "0.0.1");
    put(root, "node_modules/plain/package.json", pkg("plain"));
    put(root, "node_modules/x/node_modules/plain/package.json", pkg("plain"));
    // two copies of a package with no install script share nothing that could be allowed
    expect([...sharedInstallNames(workspaceTree(root)).keys()]).toEqual(["esbuild"]);
  });

  it("even its own writer may only add files or replace native binaries (reading 254(2))", () => {
    const root = monorepo();
    put(root, `${ESBUILD}/lib/main.js`, MAIN_JS);
    put(root, `${ESBUILD}/lib/types.d.ts`, "export {};\n");
    put(root, `${ESBUILD}/build/Release/esbuild.node`, "old native");
    put(root, `${ESBUILD}/README.md`, "# esbuild\n");
    const before = workspaceTree(root);
    put(root, `${ESBUILD}/bin/esbuild`, "\u007fELF native", 0o755);
    put(root, `${ESBUILD}/build/Release/esbuild.node`, "new native");
    put(root, `${ESBUILD}/lib/downloaded-esbuild.js`, "// added\n");
    put(root, `${ESBUILD}/lib/main.js`, PATCHED);
    put(root, `${ESBUILD}/lib/types.d.ts`, "export const x = 1;\n");
    put(root, `${ESBUILD}/install.js`, "// rewritten\n");
    rmSync(join(root, `${ESBUILD}/README.md`));
    expect(
      compareInstall(before, workspaceTree(root), isProtected, { dependency: "esbuild" }),
    ).toEqual({
      tampered: [
        `${ESBUILD}/README.md`,
        `${ESBUILD}/install.js`,
        `${ESBUILD}/lib/main.js`,
        `${ESBUILD}/lib/types.d.ts`,
      ],
      selfRebuilt: [
        {
          package: ESBUILD,
          files: [
            `${ESBUILD}/bin/esbuild`,
            `${ESBUILD}/build/Release/esbuild.node`,
            `${ESBUILD}/lib/downloaded-esbuild.js`,
          ],
        },
      ],
      managerState: [],
    });
  });

  it("h14-unprotected-tool-config-additions-allowed: babel, swc, cargo, go.work and .pytest.ini are protected", () => {
    for (const path of [
      "babel.config.js",
      "packages/web/babel.config.cjs",
      ".babelrc",
      "packages/web/.babelrc.json",
      ".swcrc",
      ".cargo/config",
      ".cargo/config.toml",
      "crates/a/.cargo/config.toml",
      "go.work",
      "go.work.sum",
      ".pytest.ini",
    ]) {
      expect(isProtected(path), path).toBe(true);
    }
  });

  it("a project's install script may add files only under its build-output directories (reading 254(3))", () => {
    const root = monorepo();
    put(root, "packages/app/package.json", pkg("app", { scripts: { prepare: "node gen.js" } }));
    const before = workspaceTree(root);
    const added = [
      "packages/app/babel.config.js",
      "packages/app/.cargo/config.toml",
      "packages/app/go.work",
      "packages/app/.pytest.ini",
      "packages/app/pytest.py",
      "packages/app/src/generated.ts",
      "packages/app/lib/index.js",
      "packages/app/dist/index.js",
      "packages/app/build/out.js",
      "packages/app/out/a.js",
      "packages/app/.next/server.js",
      "packages/app/target/debug/app",
      "packages/app/dist/babel.config.js",
    ];
    for (const path of added) put(root, path, "x");
    const after = workspaceTree(root);
    const writer = { project: "packages/app" };
    const builds = [
      "packages/app/.next/server.js",
      "packages/app/build/out.js",
      "packages/app/dist/index.js",
      "packages/app/out/a.js",
      "packages/app/target/debug/app",
    ];
    const always = [
      "packages/app/.cargo/config.toml",
      "packages/app/.pytest.ini",
      "packages/app/babel.config.js",
      "packages/app/dist/babel.config.js",
      "packages/app/go.work",
      "packages/app/pytest.py",
      "packages/app/src/generated.ts",
    ];
    expect(compareInstall(before, after, isProtected, writer)).toEqual({
      tampered: [...always, "packages/app/lib/index.js"].sort(),
      selfRebuilt: [{ package: "packages/app", files: builds }],
      managerState: [],
    });
    // lib/ only when the project's .gitignore ignores it
    expect(
      compareInstall(before, after, isProtected, writer, { ignoredLib: new Set(["packages/app"]) }),
    ).toEqual({
      tampered: always,
      selfRebuilt: [
        { package: "packages/app", files: [...builds, "packages/app/lib/index.js"].sort() },
      ],
      managerState: [],
    });
  });
});

describe("reading 255: a shared name keeps its allowance where the rebuild cannot mix the packages up", () => {
  /** The checkout's snapshot, its root's pnpm store populated by this run's install (256(3)). */
  const workspaceTree = (root: string): WorkspaceTree =>
    walk(root, { writable: [JAIL], pnpmStores: [""] });
  const isProtected = (path: string): boolean => matchesAnyCaseless(DEFAULT_PROTECTED_GLOBS, path);
  const MAIN_JS = "export const transform = (code) => code;\n";
  const PATCHED = "export const transform = (code) => code.replace(/expect\\(/g, 'void (');\n";
  const NATIVE = "\u007fELF native";
  const esbuildAt = (root: string, dir: string, version: string): void => {
    put(
      root,
      `${dir}/package.json`,
      JSON.stringify({
        name: "esbuild",
        version,
        scripts: { postinstall: "node install.js" },
        bin: { esbuild: "bin/esbuild" },
      }),
    );
    put(root, `${dir}/install.js`, "// rebuilds bin/esbuild\n");
    put(root, `${dir}/bin/esbuild`, "#!/usr/bin/env node\n// js fallback\n", 0o755);
    put(root, `${dir}/lib/main.js`, MAIN_JS);
  };
  const integrity = (text: string): string =>
    `sha512-${createHash("sha512").update(text).digest("base64")}`;
  /** A pnpm-lock.yaml (v9) whose `packages` entries have the given resolutions. */
  const lockfile = (entries: Record<string, string>): string =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      esbuild:\n        specifier: ^0.25.0\n        version: 0.25.0\n\npackages:\n\n${Object.entries(
      entries,
    )
      .map(
        ([key, resolution]) =>
          `  ${key.startsWith("@") ? `'${key}'` : key}:\n    resolution: ${resolution}\n    engines: {node: '>=18'}\n    hasBin: true\n`,
      )
      .join(
        "\n",
      )}\nsnapshots:\n\n  esbuild@0.25.0:\n    optionalDependencies:\n      '@esbuild/darwin-arm64': 0.25.0\n`;
  const OLD = "node_modules/.pnpm/esbuild@0.21.5/node_modules/esbuild";
  const NEW = "node_modules/.pnpm/esbuild@0.25.0/node_modules/esbuild";
  /** vite's esbuild 0.21.5 beside the project's 0.25.0, both from the registry, under pnpm. */
  const pnpmTwoVersions = (resolutions: Record<string, string> = {}): string => {
    const root = tempDir("vtc-pnpm-");
    put(root, "package.json", pkg("app", { pnpm: { onlyBuiltDependencies: ["esbuild"] } }));
    esbuildAt(root, OLD, "0.21.5");
    esbuildAt(root, NEW, "0.25.0");
    put(root, "node_modules/.pnpm/vite@5.4.0/node_modules/vite/package.json", pkg("vite"));
    link(
      root,
      "node_modules/.pnpm/vite@5.4.0/node_modules/esbuild",
      "../../esbuild@0.21.5/node_modules/esbuild",
    );
    link(root, "node_modules/esbuild", ".pnpm/esbuild@0.25.0/node_modules/esbuild");
    link(root, "node_modules/vite", ".pnpm/vite@5.4.0/node_modules/vite");
    put(
      root,
      "pnpm-lock.yaml",
      lockfile({
        "esbuild@0.21.5": `{integrity: ${integrity("0.21.5")}}`,
        "esbuild@0.25.0": `{integrity: ${integrity("0.25.0")}}`,
        "vite@5.4.0": `{integrity: ${integrity("vite")}}`,
        ...resolutions,
      }),
    );
    put(
      root,
      "node_modules/.modules.yaml",
      "pendingBuilds:\n  - esbuild@0.21.5\n  - esbuild@0.25.0\nregistries:\n  default: https://registry.npmjs.org/\n",
    );
    return root;
  };

  it("npm: esbuild 0.21 for vite and 0.25 beside it each rebuild their own binary", () => {
    const root = tempDir("vtc-npm-");
    put(root, "package.json", pkg("app"));
    esbuildAt(root, "node_modules/esbuild", "0.25.0");
    put(root, "node_modules/vite/package.json", pkg("vite"));
    esbuildAt(root, "node_modules/vite/node_modules/esbuild", "0.21.5");
    const before = workspaceTree(root);
    const steps = perPackageBuild(["npm", "ci"], root, "", before) ?? [];
    expect(steps.map((s) => s.writer)).toEqual([
      { installed: "node_modules/esbuild" },
      { installed: "node_modules/vite/node_modules/esbuild" },
    ]);
    put(root, "node_modules/esbuild/bin/esbuild", NATIVE, 0o755);
    put(root, "node_modules/esbuild/esbuild.node", NATIVE);
    const mid = workspaceTree(root);
    expect(compareInstall(before, mid, isProtected, steps[0]?.writer ?? null)).toEqual({
      tampered: [],
      selfRebuilt: [
        {
          package: "node_modules/esbuild",
          files: ["node_modules/esbuild/bin/esbuild", "node_modules/esbuild/esbuild.node"],
        },
      ],
      managerState: [],
    });
    put(root, "node_modules/vite/node_modules/esbuild/bin/esbuild", NATIVE, 0o755);
    expect(compareInstall(mid, workspaceTree(root), isProtected, steps[1]?.writer ?? null)).toEqual(
      {
        tampered: [],
        selfRebuilt: [
          {
            package: "node_modules/vite/node_modules/esbuild",
            files: ["node_modules/vite/node_modules/esbuild/bin/esbuild"],
          },
        ],
        managerState: [],
      },
    );
    // still one directory each: the 0.25 step writing into 0.21, or its own JavaScript, fails
    const again = workspaceTree(root);
    put(root, "node_modules/vite/node_modules/esbuild/bin/esbuild", "other", 0o755);
    put(root, "node_modules/vite/node_modules/esbuild/lib/main.js", PATCHED);
    put(root, "node_modules/esbuild/lib/main.js", PATCHED);
    expect(
      compareInstall(again, workspaceTree(root), isProtected, steps[0]?.writer ?? null).tampered,
    ).toEqual([
      "node_modules/esbuild/lib/main.js",
      "node_modules/vite/node_modules/esbuild/bin/esbuild",
      "node_modules/vite/node_modules/esbuild/lib/main.js",
    ]);
  });

  it("pnpm: both from the registry with an integrity hash, each rebuilt by name and version", () => {
    const root = pnpmTwoVersions();
    const before = workspaceTree(root);
    expect(before.packages.get(OLD)?.registry).toBe(true);
    expect(before.packages.get(NEW)?.registry).toBe(true);
    expect([...sharedInstallNames(before).keys()]).toEqual(["esbuild"]);
    expect(unverifiedSharedNames(before)).toEqual(new Map());
    const steps = perPackageBuild(["pnpm", "install", "--frozen-lockfile"], root, "", before);
    expect(steps).toEqual([
      {
        argv: ["pnpm", "rebuild", "--recursive", "esbuild@0.21.5"],
        writer: { dependency: "esbuild", version: "0.21.5" },
      },
      {
        argv: ["pnpm", "rebuild", "--recursive", "esbuild@0.25.0"],
        writer: { dependency: "esbuild", version: "0.25.0" },
      },
    ]);
    put(root, `${OLD}/bin/esbuild`, NATIVE, 0o755);
    const mid = workspaceTree(root);
    expect(compareInstall(before, mid, isProtected, steps?.[0]?.writer ?? null)).toEqual({
      tampered: [],
      selfRebuilt: [{ package: OLD, files: [`${OLD}/bin/esbuild`] }],
      managerState: [],
    });
    put(root, `${NEW}/bin/esbuild`, NATIVE, 0o755);
    put(root, `${NEW}/esbuild.node`, NATIVE);
    expect(
      compareInstall(mid, workspaceTree(root), isProtected, steps?.[1]?.writer ?? null),
    ).toEqual({
      tampered: [],
      selfRebuilt: [{ package: NEW, files: [`${NEW}/bin/esbuild`, `${NEW}/esbuild.node`] }],
      managerState: [],
    });
    // the 0.25.0 step may not touch 0.21.5, nor change its own JavaScript (reading 254(2))
    const again = workspaceTree(root);
    put(root, `${OLD}/bin/esbuild`, "other", 0o755);
    put(root, `${OLD}/lib/main.js`, PATCHED);
    put(root, `${NEW}/lib/main.js`, PATCHED);
    expect(
      compareInstall(again, workspaceTree(root), isProtected, steps?.[1]?.writer ?? null),
    ).toEqual({
      tampered: [`${OLD}/bin/esbuild`, `${OLD}/lib/main.js`, `${NEW}/lib/main.js`],
      selfRebuilt: [],
      managerState: [],
    });
    // a rebuild by name alone selects two directories, and a self-rebuild is one (reading
    // 256(2)): it may write neither esbuild's binaries
    const byName = workspaceTree(root);
    put(root, `${OLD}/esbuild.node`, NATIVE);
    put(root, `${NEW}/build/esbuild`, NATIVE);
    expect(
      compareInstall(byName, workspaceTree(root), isProtected, { dependency: "esbuild" }),
    ).toEqual({
      tampered: [`${OLD}/esbuild.node`, `${NEW}/build/esbuild`],
      selfRebuilt: [],
      managerState: [],
    });
  });

  it("pnpm: a fake esbuild from a tarball beside the registry one keeps the name's allowance off", () => {
    const root = pnpmTwoVersions();
    const FAKE = "node_modules/.pnpm/esbuild@file+vendor+esbuild-0.0.1.tgz/node_modules/esbuild";
    esbuildAt(root, FAKE, "0.0.1");
    rmSync(join(root, OLD), { recursive: true });
    put(
      root,
      "pnpm-lock.yaml",
      lockfile({
        "esbuild@0.25.0": `{integrity: ${integrity("0.25.0")}}`,
        "esbuild@file:vendor/esbuild-0.0.1.tgz": `{integrity: ${integrity("fake")}, tarball: file:vendor/esbuild-0.0.1.tgz}`,
      }),
    );
    put(
      root,
      "node_modules/.modules.yaml",
      "pendingBuilds:\n  - esbuild@0.25.0\n  - esbuild@file:vendor/esbuild-0.0.1.tgz\n",
    );
    const before = workspaceTree(root);
    expect(before.packages.get(NEW)?.registry).toBe(true);
    expect(before.packages.get(FAKE)?.registry).toBe(false);
    expect(unverifiedSharedNames(before)).toEqual(new Map([["esbuild", [NEW, FAKE].sort()]]));
    // a name with a source other than the registry: one rebuild by name, as before
    const steps = perPackageBuild(["pnpm", "install", "--frozen-lockfile"], root, "", before);
    expect(steps).toEqual([
      { argv: ["pnpm", "rebuild", "--recursive", "esbuild"], writer: { dependency: "esbuild" } },
    ]);
    put(root, `${NEW}/bin/esbuild`, NATIVE, 0o755);
    put(root, `${NEW}/lib/main.js`, PATCHED);
    put(root, `${FAKE}/bin/esbuild`, NATIVE, 0o755);
    for (const writer of [
      { dependency: "esbuild" },
      { dependency: "esbuild", version: "0.25.0" },
      { dependency: "esbuild", version: "0.0.1" },
    ]) {
      expect(compareInstall(before, workspaceTree(root), isProtected, writer)).toEqual({
        tampered: [`${NEW}/bin/esbuild`, `${NEW}/lib/main.js`, `${FAKE}/bin/esbuild`],
        selfRebuilt: [],
        managerState: [],
      });
    }
  });

  it("pnpm: only a registry resolution with an integrity hash and nothing else counts", () => {
    for (const resolution of [
      `{integrity: ${integrity("x")}, tarball: https://example.com/esbuild-0.21.5.tgz}`,
      "{tarball: https://example.com/esbuild-0.21.5.tgz}",
      "{type: git, repo: https://example.com/esbuild.git, commit: 0123456789abcdef}",
      "{directory: ../esbuild, type: directory}",
      "{}",
    ]) {
      const root = pnpmTwoVersions({ "esbuild@0.21.5": resolution });
      const tree = workspaceTree(root);
      expect(tree.packages.get(OLD)?.registry, resolution).toBe(false);
      expect([...unverifiedSharedNames(tree).keys()], resolution).toEqual(["esbuild"]);
      put(root, `${NEW}/bin/esbuild`, NATIVE, 0o755);
      expect(
        compareInstall(tree, workspaceTree(root), isProtected, {
          dependency: "esbuild",
          version: "0.25.0",
        }).tampered,
        resolution,
      ).toEqual([`${NEW}/bin/esbuild`]);
    }
    // no lockfile entry at all, no lockfile, a manifest whose version is not its folder's, a
    // package outside pnpm's virtual store
    const missing = pnpmTwoVersions();
    put(
      missing,
      "pnpm-lock.yaml",
      lockfile({ "esbuild@0.25.0": `{integrity: ${integrity("0.25.0")}}` }),
    );
    expect(workspaceTree(missing).packages.get(OLD)?.registry).toBe(false);
    const none = pnpmTwoVersions();
    rmSync(join(none, "pnpm-lock.yaml"));
    expect(workspaceTree(none).packages.get(NEW)?.registry).toBe(false);
    const copied = pnpmTwoVersions();
    esbuildAt(copied, OLD, "0.25.0");
    expect(workspaceTree(copied).packages.get(OLD)?.registry).toBe(false);
    const hoisted = pnpmTwoVersions();
    esbuildAt(hoisted, "node_modules/other/node_modules/esbuild", "0.21.5");
    const tree = workspaceTree(hoisted);
    expect(tree.packages.get("node_modules/other/node_modules/esbuild")?.registry).toBe(false);
    expect([...unverifiedSharedNames(tree).keys()]).toEqual(["esbuild"]);
  });
});

describe("reading 256 (h14-open4): a pnpm self-rebuild is one directory of the step's own store", () => {
  const isProtected = (path: string): boolean => matchesAnyCaseless(DEFAULT_PROTECTED_GLOBS, path);
  const NATIVE = "\u007fELF native";
  const REGISTRY = "https://registry.npmjs.org/";
  const EVIL_REGISTRY = "http://127.0.0.1:4873/";
  const REAL = "node_modules/.pnpm/dep@1.0.0/node_modules/dep";
  const integrity = (text: string): string =>
    `sha512-${createHash("sha512").update(text).digest("base64")}`;
  /** A pnpm-lock.yaml (v9) with each `name@version` resolved by `integrity` only. */
  const lockfile = (keys: Record<string, string>): string =>
    `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n      dep:\n        specifier: 1.0.0\n        version: 1.0.0\n\npackages:\n\n${Object.entries(
      keys,
    )
      .map(([key, hash]) => `  ${key}:\n    resolution: {integrity: ${hash}}\n`)
      .join("\n")}\nsnapshots:\n\n  dep@1.0.0: {}\n`;
  /** pnpm's `.modules.yaml` with `pendingBuilds` and the registry it installed from. */
  const modulesYaml = (pending: string[], registry = REGISTRY): string =>
    `layoutVersion: 5\npendingBuilds:\n${pending.map((p) => `  - ${p}\n`).join("")}registries:\n  default: ${registry}\nstoreDir: /tmp/store\n`;
  /** `dep` as published: a postinstall that rebuilds its own `bin/dep`, and its JavaScript. */
  const depAt = (
    root: string,
    dir: string,
    version = "1.0.0",
    install = "node install.js",
  ): void => {
    put(
      root,
      `${dir}/package.json`,
      JSON.stringify({
        name: "dep",
        version,
        scripts: { postinstall: install },
        bin: { dep: "bin/dep" },
      }),
    );
    put(root, `${dir}/install.js`, "// rebuilds bin/dep\n");
    put(root, `${dir}/bin/dep`, "#!/usr/bin/env node\n// js fallback\n", 0o755);
    put(root, `${dir}/lib/index.js`, "module.exports = 1;\n");
  };
  /** The project after `pnpm install --ignore-scripts` at the root: the real dep@1.0.0. */
  const project = (): string => {
    const root = tempDir("vtc-pnpm-");
    put(root, "package.json", pkg("app", { pnpm: { onlyBuiltDependencies: ["dep"] } }));
    put(root, "pnpm-lock.yaml", lockfile({ "dep@1.0.0": integrity("dep-1.0.0") }));
    depAt(root, REAL);
    link(root, "node_modules/dep", ".pnpm/dep@1.0.0/node_modules/dep");
    put(root, "node_modules/.modules.yaml", modulesYaml(["dep@1.0.0"]));
    return root;
  };
  /** A nested project `tools` with its own store holding `dep` at `folder`, as `version`. */
  const tools = (
    root: string,
    folder: string,
    options: { version?: string; registry?: string; install?: string } = {},
  ): string => {
    const version = options.version ?? "1.0.0";
    const dir = `tools/node_modules/.pnpm/${folder}/node_modules/dep`;
    put(root, "tools/package.json", pkg("tools", { dependencies: { dep: version } }));
    put(root, "tools/pnpm-lock.yaml", lockfile({ [`dep@${version}`]: "sha512-AAAA" }));
    put(
      root,
      "tools/node_modules/.pnpm/lock.yaml",
      lockfile({ [`dep@${version}`]: "sha512-AAAA" }),
    );
    put(
      root,
      "tools/node_modules/.modules.yaml",
      modulesYaml([`dep@${version}`], options.registry ?? REGISTRY),
    );
    link(root, "tools/node_modules/dep", `.pnpm/${folder}/node_modules/dep`);
    depAt(root, dir, version, options.install ?? "node evil.js");
    put(root, `${dir}/evil.js`, "// overwrites the root's bin/dep\n");
    return dir;
  };
  /** What the finding's fake postinstall did: the real package's binary and an added file. */
  const evil = (root: string): void => {
    put(root, `${REAL}/bin/dep`, "PWNED by dep@1.0.0\n", 0o755);
    put(root, `${REAL}/bin/added-by-evil.js`, "// planted\n");
  };
  const ONE_STEP = { dependency: "dep", version: "1.0.0" } as const;

  it("the real package alone in the store the step installed rebuilds itself", () => {
    const root = project();
    const before = workspaceTree(root, { pnpmStores: [""] });
    expect(before.packages.get(REAL)).toMatchObject({
      registry: true,
      registryHost: "registry.npmjs.org",
    });
    const steps = perPackageBuild(["pnpm", "install"], root, "", before);
    expect(steps).toEqual([
      { argv: ["pnpm", "rebuild", "--recursive", "dep@1.0.0"], writer: ONE_STEP },
    ]);
    put(root, `${REAL}/bin/dep`, NATIVE, 0o755);
    expect(compareInstall(before, workspaceTree(root), isProtected, ONE_STEP)).toEqual({
      tampered: [],
      selfRebuilt: [{ package: REAL, files: [`${REAL}/bin/dep`] }],
      managerState: [],
    });
    // the same package from another step's store is not this step's
    expect(
      compareInstall(before, workspaceTree(root), isProtected, { ...ONE_STEP, store: "tools" })
        .tampered,
    ).toEqual([`${REAL}/bin/dep`]);
  });

  it("refuses a committed dependency tree whatever its case (case-insensitive file systems)", () => {
    expect(
      committedDependencyFiles([
        "tools/Node_Modules/.pnpm/dep@1.0.0/Node_Modules/dep/bin/dep",
        ".Yarn/Unplugged/x/index.js",
        "py/env/PyVenv.cfg",
        "py/env/lib/site.py",
        "src/node_modules.ts",
      ]),
    ).toEqual([
      ".Yarn/Unplugged/x/index.js",
      "py/env/PyVenv.cfg",
      "py/env/lib/site.py",
      "tools/Node_Modules/.pnpm/dep@1.0.0/Node_Modules/dep/bin/dep",
    ]);
  });

  it("(H) a committed nested tools/node_modules fake of dep@1.0.0 rewriting the real bin is tampering", () => {
    const root = project();
    const fake = tools(root, "dep@1.0.0");
    // reading 256(1): a run refuses the committed tree before any install
    expect(
      committedDependencyFiles([
        "package.json",
        "pnpm-lock.yaml",
        "tools/package.json",
        "tools/pnpm-lock.yaml",
        "tools/node_modules/.modules.yaml",
        "tools/node_modules/dep",
        `${fake}/package.json`,
        `${fake}/evil.js`,
        "src/node_modules.ts",
        ".yarn/unplugged/x-npm-1.0.0/node_modules/x/index.js",
        ".yarn/releases/yarn-4.0.0.cjs",
        "py/env/pyvenv.cfg",
        "py/env/lib/site.py",
        "py/envx/a.py",
      ]),
    ).toEqual([
      ".yarn/unplugged/x-npm-1.0.0/node_modules/x/index.js",
      "py/env/lib/site.py",
      "py/env/pyvenv.cfg",
      "tools/node_modules/.modules.yaml",
      `${fake}/evil.js`,
      `${fake}/package.json`,
      "tools/node_modules/dep",
    ]);
    // and were it there anyway: no install gate populated tools' store, so its lockfile's text
    // vouches for nothing (256(3)), and dep@1.0.0 is installed twice (256(2))
    const before = workspaceTree(root, { pnpmStores: [""] });
    expect(before.packages.get(fake)?.registry).toBe(false);
    expect(before.packages.get(REAL)?.registry).toBe(true);
    expect(unverifiedSharedNames(before)).toEqual(new Map([["dep", [REAL, fake].sort()]]));
    const steps = perPackageBuild(["pnpm", "install"], root, "", before);
    expect(steps?.map((s) => s.writer)).toEqual([ONE_STEP]);
    for (const pnpmStores of [[""], ["", "tools"]]) {
      const again = project();
      const copy = tools(again, "dep@1.0.0");
      const from = workspaceTree(again, { pnpmStores });
      expect(from.packages.get(copy)?.registry).toBe(pnpmStores.includes("tools"));
      evil(again);
      expect(
        compareInstall(from, workspaceTree(again, { pnpmStores }), isProtected, ONE_STEP),
      ).toEqual({
        tampered: [`${REAL}/bin/added-by-evil.js`, `${REAL}/bin/dep`],
        selfRebuilt: [],
        managerState: [],
      });
    }
  });

  it("(D) a second install gate's patchedDependencies copy of dep@1.0.0 patching the root's bin is tampering", () => {
    const root = project();
    const PATCHED =
      "dep@1.0.0_patch_hash=2f3c4ab5d6e7f8091a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f";
    const fake = tools(root, PATCHED);
    put(
      root,
      "tools/package.json",
      pkg("tools", {
        dependencies: { dep: "1.0.0" },
        pnpm: { patchedDependencies: { "dep@1.0.0": "patches/dep@1.0.0.patch" } },
      }),
    );
    put(root, "tools/patches/dep@1.0.0.patch", "--- a/install.js\n+++ b/install.js\n");
    // both stores populated by this run's install gates: the patched folder is still not the
    // registry's (256(2))
    const before = workspaceTree(root, { pnpmStores: ["", "tools"] });
    expect(before.packages.get(fake)?.registry).toBe(false);
    expect([...unverifiedSharedNames(before).keys()]).toEqual(["dep"]);
    const steps = perPackageBuild(["pnpm", "install"], root, "tools", before);
    const writer = { ...ONE_STEP, store: "tools" };
    expect(steps).toEqual([{ argv: ["pnpm", "rebuild", "--recursive", "dep@1.0.0"], writer }]);
    evil(root);
    const after = workspaceTree(root, { pnpmStores: ["", "tools"] });
    expect(compareInstall(before, after, isProtected, writer)).toEqual({
      tampered: [`${REAL}/bin/added-by-evil.js`, `${REAL}/bin/dep`],
      selfRebuilt: [],
      managerState: [],
    });
    // and the root step may not rebuild the real one either: dep@1.0.0 is installed twice
    expect(compareInstall(before, after, isProtected, ONE_STEP).tampered).toEqual([
      `${REAL}/bin/added-by-evil.js`,
      `${REAL}/bin/dep`,
    ]);
    // nor may the patched one rebuild itself, alone in its store
    const alone = tempDir("vtc-pnpm-");
    const only = tools(alone, PATCHED);
    const lone = workspaceTree(alone, { pnpmStores: ["tools"] });
    put(alone, `${only}/bin/dep`, NATIVE, 0o755);
    expect(
      compareInstall(lone, workspaceTree(alone, { pnpmStores: ["tools"] }), isProtected, writer)
        .tampered,
    ).toEqual([`${only}/bin/dep`]);
  });

  it("(C) a copy of dep@1.0.0 from a second registry patching the root's bin is tampering", () => {
    const root = project();
    put(root, "tools/.npmrc", `registry=${EVIL_REGISTRY}\n`);
    const fake = tools(root, "dep@1.0.0", { registry: EVIL_REGISTRY });
    const before = workspaceTree(root, { pnpmStores: ["", "tools"] });
    // integrity-only in a store this run populated: the registry's, but another registry's
    expect(before.packages.get(fake)).toMatchObject({
      registry: true,
      registryHost: "127.0.0.1:4873",
    });
    expect(unverifiedSharedNames(before)).toEqual(new Map([["dep", [REAL, fake].sort()]]));
    evil(root);
    const after = workspaceTree(root, { pnpmStores: ["", "tools"] });
    for (const writer of [{ ...ONE_STEP, store: "tools" }, ONE_STEP]) {
      expect(compareInstall(before, after, isProtected, writer)).toEqual({
        tampered: [`${REAL}/bin/added-by-evil.js`, `${REAL}/bin/dep`],
        selfRebuilt: [],
        managerState: [],
      });
    }
  });

  it("256(5): another version of the name keeps the allowance only from the same registry host", () => {
    for (const [registry, allowed] of [
      [REGISTRY, true],
      [EVIL_REGISTRY, false],
    ] as const) {
      const root = project();
      tools(root, "dep@2.0.0", { version: "2.0.0", registry, install: "node install.js" });
      const before = workspaceTree(root, { pnpmStores: ["", "tools"] });
      put(root, `${REAL}/bin/dep`, NATIVE, 0o755);
      expect(
        compareInstall(
          before,
          workspaceTree(root, { pnpmStores: ["", "tools"] }),
          isProtected,
          ONE_STEP,
        ),
        registry,
      ).toEqual(
        allowed
          ? {
              tampered: [],
              selfRebuilt: [{ package: REAL, files: [`${REAL}/bin/dep`] }],
              managerState: [],
            }
          : { tampered: [`${REAL}/bin/dep`], selfRebuilt: [], managerState: [] },
      );
    }
    // a store whose .modules.yaml names no registry: the host is unknown, so no allowance
    const root = project();
    tools(root, "dep@2.0.0", { version: "2.0.0", install: "node install.js" });
    put(root, "tools/node_modules/.modules.yaml", "pendingBuilds:\n  - dep@2.0.0\n");
    expect([
      ...unverifiedSharedNames(workspaceTree(root, { pnpmStores: ["", "tools"] })).keys(),
    ]).toEqual(["dep"]);
  });

  it("256(2): a peer-suffixed duplicate of the same name and version takes the allowance away", () => {
    const root = project();
    const SECOND = "node_modules/.pnpm/dep@1.0.0_peer@2.0.0/node_modules/dep";
    depAt(root, SECOND);
    put(root, `${SECOND}/lib/index.js`, "module.exports = 2;\n");
    const before = workspaceTree(root, { pnpmStores: [""] });
    put(root, `${REAL}/bin/dep`, NATIVE, 0o755);
    expect(
      compareInstall(before, workspaceTree(root, { pnpmStores: [""] }), isProtected, ONE_STEP)
        .tampered,
    ).toEqual([`${REAL}/bin/dep`]);
  });

  it("256(3): without a store an install gate populated, no lockfile vouches for the registry", () => {
    const root = project();
    expect(workspaceTree(root).packages.get(REAL)?.registry).toBe(false);
    expect(workspaceTree(root, { pnpmStores: ["tools"] }).packages.get(REAL)?.registry).toBe(false);
    expect(workspaceTree(root, { pnpmStores: [""] }).packages.get(REAL)?.registry).toBe(true);
  });

  it("256(4): .npmrc, .yarnrc.yml, .pnpmfile.cjs and pnpm settings added in either comparison are tampering", () => {
    const root = project();
    put(root, "packages/app/package.json", pkg("app", { scripts: { prepare: "node gen.js" } }));
    const before = workspaceTree(root, { pnpmStores: [""] });
    const added = [
      "packages/app/.npmrc",
      "packages/app/.yarnrc.yml",
      "packages/app/.pnpmfile.cjs",
      "packages/app/dist/.npmrc",
      "packages/app/dist/pnpm-workspace.yaml",
    ];
    for (const path of added) put(root, path, "x");
    put(
      root,
      "packages/app/dist/sub/package.json",
      pkg("sub", { pnpm: { overrides: { dep: "2" } } }),
    );
    const after = workspaceTree(root, { pnpmStores: [""] });
    const expected = [...added, "packages/app/dist/sub/package.json"].sort();
    // not even with no isProtected given
    expect(compareGate(before, after)).toEqual(expected);
    expect(compareInstall(before, after, undefined, { project: "packages/app" }).tampered).toEqual(
      expected,
    );
  });
});
