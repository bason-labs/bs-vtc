/**
 * The single-file `vtc` binary (§4.4, AD-2, AD-20 rule 4; owner: cli+binary team). Run with Bun
 * after `pnpm build` (which emits the dashboard export and the compiled plugins):
 *
 *   bun scripts/build-binary.ts [--outfile <path>] [--target <bun-target>]
 *                               [--source <namespace>=<dir>]...
 *   bun scripts/build-binary.ts --storage-contract --outfile <path>
 *
 * It generates an entry module that embeds every file of each `AssetBundle` namespace
 * (`ASSET_SOURCES`: `apps/dashboard/out`, `dist/claude-plugin`, `dist/codex-plugin`, or the
 * `--source` overrides) with `import … with { type: "file" }` and hands their embedded paths to
 * `runBinary` (`src/binary/main.ts`), then runs `bun build --compile` on it. Workspace packages
 * resolve to their TypeScript sources (`@vtc/source`). `--storage-contract` instead compiles the
 * engine's Storage contract suite (`runStorageContract`, unchanged) against `bun:sqlite` into a
 * test binary, with `vitest` mapped to a small runner (`test/bun/vitest-shim.ts`).
 * Signing and notarization are not part of this build.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

/** The slice of the Bun API this script uses (Bun's types are not a dependency). */
interface BunPlugin {
  readonly name: string;
  setup(build: {
    onResolve(options: { filter: RegExp }, callback: () => { path: string }): void;
  }): void;
}
interface BunBuildApi {
  build(config: {
    entrypoints: string[];
    compile: { outfile: string; target?: string };
    conditions: string[];
    minify?: boolean;
    sourcemap?: "none" | "inline" | "linked";
    plugins?: BunPlugin[];
  }): Promise<{ success: boolean; logs: unknown[] }>;
}

const CLI_ROOT = fileURLToPath(new URL("../", import.meta.url));
const PRODUCT_ROOT = resolve(CLI_ROOT, "../..");

/** Mirrors `ASSET_SOURCES` in @vtc/shared (asserted equal by the binary test). */
export const DEFAULT_SOURCES: Readonly<Record<string, string>> = {
  dashboard: "apps/dashboard/out",
  "plugin:claude-code": "dist/claude-plugin",
  "plugin:codex": "dist/codex-plugin",
};

const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const entry of readdirSync(rel === "" ? root : join(root, rel), {
      withFileTypes: true,
    })) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("");
  return out.sort();
};

/**
 * The generated entry: one embedded-file import per asset, the lockfile the binary is built from
 * (the daemon's daily scan of VTC's own dependencies reads it, reading 216), then `runBinary`.
 */
export const renderEntry = (
  sources: Readonly<Record<string, string>>,
  lockfile: string = join(PRODUCT_ROOT, "pnpm-lock.yaml"),
): string => {
  const imports: string[] = [];
  const manifest: Record<string, Record<string, string>> = {};
  let n = 0;
  for (const [namespace, dir] of Object.entries(sources)) {
    const files: Record<string, string> = {};
    for (const path of listFiles(dir)) {
      const id = `a${String(n++)}`;
      imports.push(`import ${id} from ${JSON.stringify(join(dir, path))} with { type: "file" };`);
      files[path] = id;
    }
    manifest[namespace] = files;
  }
  const body = Object.entries(manifest)
    .map(
      ([ns, files]) =>
        `  ${JSON.stringify(ns)}: {\n${Object.entries(files)
          .map(([path, id]) => `    ${JSON.stringify(path)}: ${id},`)
          .join("\n")}\n  },`,
    )
    .join("\n");
  return [
    `import { runBinary } from ${JSON.stringify(join(CLI_ROOT, "src/binary/main.ts"))};`,
    ...imports,
    `import lockfile from ${JSON.stringify(lockfile)} with { type: "file" };`,
    `runBinary({\n${body}\n}, lockfile);`,
    "",
  ].join("\n");
};

const bunApi = (): BunBuildApi => {
  const api = (globalThis as { Bun?: BunBuildApi }).Bun;
  if (api === undefined) throw new Error("run this script with bun: bun scripts/build-binary.ts");
  return api;
};

const compile = async (
  entry: string,
  outfile: string,
  target: string | undefined,
  plugins: BunPlugin[] = [],
): Promise<void> => {
  mkdirSync(dirname(outfile), { recursive: true });
  const before = new Set(readdirSync(process.cwd()));
  try {
    await compileOnce(entry, outfile, target, plugins);
  } finally {
    // Bun 1.4 leaves a `.<hash>-00000000.bun-build` copy of the binary in the working directory.
    for (const name of readdirSync(process.cwd()))
      if (name.endsWith(".bun-build") && !before.has(name))
        rmSync(join(process.cwd(), name), { force: true });
  }
};

const compileOnce = async (
  entry: string,
  outfile: string,
  target: string | undefined,
  plugins: BunPlugin[],
): Promise<void> => {
  const result = await bunApi().build({
    entrypoints: [entry],
    compile: { outfile, ...(target === undefined ? {} : { target }) },
    conditions: ["@vtc/source"],
    minify: true,
    sourcemap: "none",
    plugins,
  });
  if (!result.success)
    throw new Error(`bun build --compile failed:\n${result.logs.map(String).join("\n")}`);
};

export const buildBinary = async (options: {
  readonly outfile: string;
  readonly target?: string;
  readonly sources?: Readonly<Record<string, string>>;
}): Promise<string> => {
  const sources: Record<string, string> = {};
  for (const [ns, rel] of Object.entries({ ...DEFAULT_SOURCES, ...options.sources })) {
    const dir = resolve(PRODUCT_ROOT, rel);
    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory())
      throw new Error(`${ns}: ${dir} does not exist; run pnpm build first (or pass --source)`);
    sources[ns] = dir;
  }
  const gen = mkdtempSync(join(tmpdir(), "vtc-binary-"));
  try {
    const entry = join(gen, "entry.ts");
    writeFileSync(entry, renderEntry(sources));
    await compile(entry, options.outfile, options.target);
  } finally {
    rmSync(gen, { recursive: true, force: true });
  }
  return options.outfile;
};

/** The engine's Storage contract suite on `bun:sqlite`, compiled into a test binary. */
export const buildStorageContractBinary = async (outfile: string): Promise<string> => {
  const shim = join(CLI_ROOT, "test/bun/vitest-shim.ts");
  await compile(join(CLI_ROOT, "test/bun/storage-contract.entry.ts"), outfile, undefined, [
    {
      name: "vitest-shim",
      setup: (build) => {
        build.onResolve({ filter: /^vitest$/ }, () => ({ path: shim }));
      },
    },
  ]);
  return outfile;
};

const cli = async (): Promise<void> => {
  const { values } = parseArgs({
    options: {
      outfile: { type: "string", default: join(CLI_ROOT, "dist/bin/vtc") },
      target: { type: "string" },
      source: { type: "string", multiple: true, default: [] },
      "storage-contract": { type: "boolean", default: false },
    },
    strict: true,
  });
  const outfile = resolve(values.outfile);
  if (values["storage-contract"]) {
    await buildStorageContractBinary(outfile);
  } else {
    const sources: Record<string, string> = {};
    for (const pair of values.source) {
      const at = pair.indexOf("=");
      const ns = pair.slice(0, at);
      if (at < 1 || !(ns in DEFAULT_SOURCES))
        throw new Error(
          `--source takes <namespace>=<dir>, namespace one of ${Object.keys(DEFAULT_SOURCES).join(", ")}`,
        );
      sources[ns] = resolve(pair.slice(at + 1));
    }
    await buildBinary({
      outfile,
      sources,
      ...(values.target === undefined ? {} : { target: values.target }),
    });
  }
  process.stdout.write(`built ${outfile}\n`);
};

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
