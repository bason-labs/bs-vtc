// Dependency rules for VTC's own code. Each rule names the AD in
// docs/architecture/vtc-spine.md that it enforces (the AD's "Check").
// Run: pnpm deps:check. Every rule is proven to fire by tooling/arch-tests (planted fixtures).

/** Node built-ins that Bun also implements, so engine/cli/adapter code runs in the binary (AD-2 rule 6). */
const RUNTIME_SAFE_BUILTINS = [
  "assert",
  "buffer",
  "child_process",
  "crypto",
  "events",
  "fs",
  "fs/promises",
  "http",
  "net",
  "os",
  "path",
  "process",
  "readline",
  "stream",
  "stream/promises",
  "string_decoder",
  "timers",
  "timers/promises",
  "url",
  "util",
  "zlib",
];
const ENGINE_MODULES = "(core|daemon|gates|git|http|mcp)";
/**
 * Build output of any package or app. It is cruised (so imports INTO it are seen and rejected)
 * but never followed, and nothing it contains is checked as a source of dependencies.
 */
const BUILD_OUTPUT = "^(packages|apps)/[^/]+/(dist|out|\\.next)/";

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    // ---- AD-1: package boundaries and dependency direction ----------------
    {
      name: "AD1-shared-has-no-internal-deps",
      comment:
        "packages/shared is the frozen contract layer. It may not import any other VTC package or app.",
      severity: "error",
      from: { path: "^packages/shared/" },
      to: { path: "^(packages/(engine|adapters|compiler|cli)|apps)/" },
    },
    {
      name: "AD1-adapters-depend-only-on-shared",
      comment: "Host adapters may import @vtc/shared only (never engine, compiler, cli or apps).",
      severity: "error",
      from: { path: "^packages/adapters/" },
      to: { path: "^(packages/(engine|compiler|cli)|apps)/" },
    },
    {
      name: "AD1-adapter-families-are-isolated",
      comment: "The claude-code and codex adapters may not import each other.",
      severity: "error",
      from: { path: "^packages/adapters/src/(claude-code|codex)/" },
      to: {
        path: "^packages/adapters/src/(claude-code|codex)/",
        pathNot: "^packages/adapters/src/$1/",
      },
    },
    {
      name: "AD1-engine-uses-adapter-interfaces-only",
      comment:
        "The engine depends on @vtc/shared (which holds the HostAdapter interface), never on adapter implementations, the compiler, the cli or apps. The cli injects concrete adapters.",
      severity: "error",
      from: { path: "^packages/engine/" },
      to: { path: "^(packages/(adapters|compiler|cli)|apps)/" },
    },
    {
      name: "AD1-compiler-depends-only-on-shared",
      comment: "The role compiler may import @vtc/shared only.",
      severity: "error",
      from: { path: "^packages/compiler/" },
      to: { path: "^(packages/(engine|adapters|cli)|apps)/" },
    },
    {
      name: "AD1-nothing-imports-the-cli",
      comment: "packages/cli is the composition root; no other package may import it.",
      severity: "error",
      from: { path: "^(packages/(shared|engine|adapters|compiler)|apps)/" },
      to: { path: "^packages/cli/" },
    },
    {
      name: "AD1-dashboard-talks-to-engine-over-http-only",
      comment:
        "apps/dashboard may import @vtc/shared contracts only. It reaches the engine over HTTP/SSE, never by import.",
      severity: "error",
      from: { path: "^apps/dashboard/" },
      to: { path: "^packages/(engine|adapters|compiler|cli)/" },
    },
    {
      name: "AD1-no-package-imports-apps",
      comment: "Packages never import from apps/.",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "AD1-no-imports-of-build-output",
      comment:
        "Code imports other packages through their entry, which resolves to source (AD-10 rule 2). An import of build output (dist/, out/, .next/) bypasses every AD-1 rule and would pass tsc once dist/ exists.",
      severity: "error",
      from: { pathNot: BUILD_OUTPUT },
      to: { path: BUILD_OUTPUT },
    },
    {
      name: "AD1-no-deep-imports-across-packages",
      comment:
        "Imports from another package (from packages/ or apps/) go through its entry point (src/index.ts), never into its internals.",
      severity: "error",
      from: { path: "^(packages|apps)/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/src/.+",
        pathNot: ["^$1/$2/", "^packages/[^/]+/src/index\\.ts$"],
      },
    },
    {
      name: "AD1-test-support-through-the-sanctioned-entry",
      comment:
        "A package's test/ code is its own. Another package may use only test support that a package exports on purpose: @vtc/engine/test-support, the Storage contract suite (AD-2), which the binary build runs unchanged against bun:sqlite (spine §5 reading 68).",
      severity: "error",
      from: { path: "^(packages|apps)/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/test/.+",
        pathNot: ["^$1/$2/", "^packages/engine/test/storage-contract\\.ts$"],
      },
    },
    // ---- AD-2: runtime-agnostic code + storage abstraction ----------------
    {
      name: "AD2-shared-is-runtime-agnostic",
      comment:
        "packages/shared runs in Node, Bun and the browser (dashboard). It may not import Node/Bun built-ins.",
      severity: "error",
      from: { path: "^packages/shared/src/", pathNot: "\\.test\\.ts$" },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "AD2-runtime-builtins-allowlist",
      comment:
        "Engine, cli, adapters and compiler use only Node built-ins Bun also implements (RUNTIME_SAFE_BUILTINS); anything else goes behind an interface. node:sqlite and bun:* have their own rules.",
      severity: "error",
      from: { path: "^packages/(engine|adapters|compiler|cli)/src/" },
      to: {
        dependencyTypes: ["core"],
        pathNot: `^((node:)?(${[...RUNTIME_SAFE_BUILTINS, "sqlite"].join("|")})|bun:.+)$`,
      },
    },
    {
      name: "AD2-node-sqlite-only-in-its-driver",
      comment: "node:sqlite is imported only by the Node storage driver.",
      severity: "error",
      from: { pathNot: "^packages/engine/src/storage/node-sqlite\\.ts$" },
      to: { path: "^(node:)?sqlite$" },
    },
    {
      name: "AD2-bun-builtins-only-in-bun-driver",
      comment:
        "bun:* modules are imported only by the Bun storage driver (it also keeps packages/shared Bun-free).",
      severity: "error",
      from: { pathNot: "^packages/engine/src/storage/bun-sqlite\\.ts$" },
      to: { path: "^bun:" },
    },
    {
      name: "AD2-storage-drivers-loaded-by-the-entry-only",
      comment:
        "Only packages/engine/src/index.ts loads a storage driver (lazily); engine code uses the Storage interface.",
      severity: "error",
      from: {
        path: "^packages/engine/src/",
        pathNot: "^packages/engine/src/(index\\.ts|storage/)",
      },
      to: { path: "^packages/engine/src/storage/" },
    },
    // ---- AD-13: engine modules ---------------------------------------------
    {
      name: "AD13-engine-modules-use-each-others-entry",
      comment:
        "Engine modules (core, gates, git, http, mcp) import each other only through the other module's index.ts.",
      severity: "error",
      from: { path: `^packages/engine/src/([^/]+)/` },
      to: {
        path: `^packages/engine/src/${ENGINE_MODULES}/.+`,
        pathNot: [`^packages/engine/src/$1/`, `^packages/engine/src/${ENGINE_MODULES}/index\\.ts$`],
      },
    },
    {
      name: "AD13-core-uses-the-gate-runner-interface",
      comment:
        "Engine core and the daemon composer never import the gates module: they call the GateRunner interface from @vtc/shared, injected through EngineDeps (AD-19).",
      severity: "error",
      from: { path: "^packages/engine/src/(core|daemon)/" },
      to: { path: "^packages/engine/src/gates/" },
    },
    {
      name: "AD19-only-the-engine-entry-imports-the-daemon",
      comment:
        "daemon/ composes the engine modules; only the engine entry re-exports it. No module imports it back.",
      severity: "error",
      from: { path: "^packages/engine/src/(core|gates|git|http|mcp|storage)/" },
      to: { path: "^packages/engine/src/daemon/" },
    },
    {
      name: "AD13-gates-never-import-engine-core",
      comment: "The Gate Runner never imports engine core or the transports (http, mcp).",
      severity: "error",
      from: { path: "^packages/engine/src/gates/" },
      to: { path: "^packages/engine/src/(core|http|mcp)/" },
    },
    {
      name: "AD13-git-imports-no-engine-module",
      comment: "The git/worktree module is a leaf: it imports no other engine module.",
      severity: "error",
      from: { path: "^packages/engine/src/git/" },
      to: { path: "^packages/engine/src/(core|daemon|gates|http|mcp|storage)/" },
    },
    {
      name: "AD13-core-does-not-import-transports",
      comment:
        "http and mcp are transports that call engine core; core, gates and git never import them.",
      severity: "error",
      from: { path: "^packages/engine/src/(core|gates|git)/" },
      to: { path: "^packages/engine/src/(http|mcp)/" },
    },
    // ---- AD-11: tests stay out of production code --------------------------
    {
      name: "AD11-no-test-code-in-production",
      severity: "error",
      from: { pathNot: "(\\.test\\.tsx?$|/test/|vitest\\.)" },
      to: { path: "(\\.test\\.tsx?$|/test/)" },
    },
    {
      name: "AD11-no-dev-deps-in-production",
      comment: "Production code (packages and apps) may not import devDependencies.",
      severity: "error",
      from: { path: "^(packages|apps)/[^/]+/src/", pathNot: "\\.test\\.tsx?$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    // ---- hygiene -----------------------------------------------------------
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment: "Every import must resolve (bun:* is resolved only inside the Bun binary build).",
      severity: "error",
      from: {},
      to: { couldNotResolve: true, pathNot: "^bun:" },
    },
    {
      name: "no-undeclared-deps",
      comment: "Every npm import must be declared in the importing package's package.json.",
      severity: "error",
      from: {},
      to: { dependencyTypes: ["npm-no-pkg", "npm-unknown"] },
    },
  ],
  options: {
    // Build output is cruised as a target (AD1-no-imports-of-build-output sees imports into it)
    // but never followed. Excluding it would hide such imports from every rule.
    doNotFollow: { path: ["node_modules", BUILD_OUTPUT] },
    exclude: { path: "^(packages|apps)/[^/]+/(coverage|\\.turbo)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["@vtc/source", "import", "types", "node", "default"],
      mainFields: ["module", "main", "types"],
      extensions: [".ts", ".tsx", ".d.ts", ".js", ".jsx", ".mjs", ".cjs", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
