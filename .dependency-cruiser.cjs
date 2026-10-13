// Dependency rules for VTC's own code. Each rule names the AD in
// docs/architecture/vtc-spine.md that it enforces (the AD's "Check").
// Run: pnpm deps:check
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
      name: "AD1-no-deep-imports-across-packages",
      comment:
        "Cross-package imports go through the package entry point (src/index.ts), not into another package's internals.",
      severity: "error",
      from: { path: "^packages/([^/]+)/" },
      to: {
        path: "^packages/([^/]+)/src/.+",
        pathNot: ["^packages/$1/", "^packages/[^/]+/src/index\\.ts$"],
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
      name: "AD2-shared-forbids-bun-builtins",
      severity: "error",
      from: { path: "^packages/shared/src/" },
      to: { path: "^bun:" },
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
        "bun:* modules are imported only by the Bun storage driver (added with the binary build).",
      severity: "error",
      from: { pathNot: "^packages/engine/src/storage/bun-sqlite\\.ts$" },
      to: { path: "^bun:" },
    },
    // ---- AD-11: tests stay out of production code --------------------------
    {
      name: "AD11-no-test-code-in-production",
      severity: "error",
      from: { pathNot: "(\\.test\\.ts$|/test/|vitest\\.)" },
      to: { path: "(\\.test\\.ts$|/test/)" },
    },
    {
      name: "AD11-no-dev-deps-in-production",
      comment: "Production code may not import devDependencies.",
      severity: "error",
      from: { path: "^packages/[^/]+/src/", pathNot: "\\.test\\.ts$" },
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
    doNotFollow: { path: "node_modules" },
    exclude: { path: "^(packages|apps)/[^/]+/(dist|coverage|\\.turbo)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    tsConfig: { fileName: "tsconfig.depcruise.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["@vtc/source", "import", "types", "node", "default"],
      mainFields: ["module", "main", "types"],
      extensions: [".ts", ".js", ".json"],
    },
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
};
