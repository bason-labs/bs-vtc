/**
 * The `AssetBundle` the cli builds and injects (AD-2 rule 7, AD-20): the dashboard's static
 * export and the compiled plugins (`plugin:<host>`, which carry `vtc/role-contracts.json` and
 * `vtc-manifest.json`). In development it reads `ASSET_SOURCES` from the product repo on disk;
 * the binary embeds the same trees (`binary/main.ts`). The cli never imports `apps/` or `dist/`:
 * it reads files at run time or embeds them at build time.
 */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, sep } from "node:path";
import { ASSET_SOURCES, type AssetBundle, type AssetNamespace } from "@vtc/shared";

export const ASSET_NAMESPACES = Object.keys(ASSET_SOURCES) as AssetNamespace[];

/** True for a POSIX relative path with no empty, `.` or `..` segment, backslash or NUL. */
export const isSafeAssetPath = (path: string): boolean =>
  path.length > 0 &&
  !path.includes("\\") &&
  !path.includes("\0") &&
  path.split("/").every((s) => s !== "" && s !== "." && s !== "..");

/** Every regular file under `root` as sorted POSIX paths; symlinks are never followed. */
export const listFiles = (root: string): string[] => {
  const out: string[] = [];
  const walk = (rel: string): void => {
    let entries;
    try {
      entries = readdirSync(rel === "" ? root : join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  walk("");
  return out.sort();
};

/**
 * Development bundle: each namespace is a directory on disk (`ASSET_SOURCES` under the product
 * repo root by default). A missing directory is an empty namespace. Reads refuse unsafe paths,
 * symlinks and anything resolving outside the namespace root.
 */
export const createDiskAssetBundle = (
  roots: Readonly<Partial<Record<AssetNamespace, string>>>,
): AssetBundle => {
  const realRoot = (namespace: AssetNamespace): string | null => {
    const root = roots[namespace];
    if (root === undefined) return null;
    try {
      return realpathSync(root);
    } catch {
      return null;
    }
  };
  return {
    read: (namespace, path) => {
      const root = realRoot(namespace);
      if (root === null || !isSafeAssetPath(path)) return undefined;
      const abs = join(root, ...path.split("/"));
      try {
        if (!lstatSync(abs).isFile()) return undefined;
        if (!realpathSync(abs).startsWith(root + sep)) return undefined;
        return new Uint8Array(readFileSync(abs));
      } catch {
        return undefined;
      }
    },
    list: (namespace) => {
      const root = realRoot(namespace);
      return root === null ? [] : listFiles(root);
    },
  };
};

/** The development roots: `ASSET_SOURCES` resolved against the product repo root. */
export const devAssetRoots = (productRoot: string): Record<AssetNamespace, string> =>
  Object.fromEntries(
    ASSET_NAMESPACES.map((ns) => [ns, join(productRoot, ...ASSET_SOURCES[ns].split("/"))]),
  ) as Record<AssetNamespace, string>;

/**
 * What the binary build embeds: per namespace, each asset path mapped to the file the compiled
 * binary holds it as (a `/$bunfs/…` path, readable with `node:fs`).
 */
export type EmbeddedAssetFiles = Readonly<
  Partial<Record<AssetNamespace, Readonly<Record<string, string>>>>
>;

/** Binary bundle over the embedded files. `readFile` is injectable for tests. */
export const createEmbeddedAssetBundle = (
  files: EmbeddedAssetFiles,
  readFile: (embedded: string) => Uint8Array = (p) => new Uint8Array(readFileSync(p)),
): AssetBundle => {
  const sorted = new Map(
    ASSET_NAMESPACES.map((ns) => [ns, Object.keys(files[ns] ?? {}).sort()] as const),
  );
  return {
    read: (namespace, path) => {
      const map = files[namespace];
      if (map === undefined || !Object.hasOwn(map, path)) return undefined;
      const embedded = map[path];
      if (embedded === undefined) return undefined;
      try {
        return readFile(embedded);
      } catch {
        return undefined;
      }
    },
    list: (namespace) => sorted.get(namespace) ?? [],
  };
};

/**
 * Writes every asset of `namespace` under `dest` (AD-20 rule 5: the binary's plugins must be on
 * disk for `HostAdapter.install`). The tree is built in a uniquely named staging directory beside
 * `dest`, the old tree (if any) is renamed aside and the new one renamed into place, so a reader
 * never sees half a plugin and two concurrent extractions do not collide; the loser of a race
 * leaves the winner's identical tree in place. Files are written 0644: the `AssetBundle` contract
 * carries no file modes, and no plugin ships an executable (its hooks run `vtc hook`).
 */
export const extractNamespace = (
  bundle: AssetBundle,
  namespace: AssetNamespace,
  dest: string,
): string => {
  const paths = bundle.list(namespace);
  if (paths.length === 0) throw new Error(`the bundle has no ${namespace} assets`);
  mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
  const unique = `${String(process.pid)}-${randomBytes(4).toString("hex")}`;
  const staging = `${dest}.${unique}.tmp`;
  for (const path of paths) {
    if (!isSafeAssetPath(path)) throw new Error(`unsafe asset path ${path}`);
    const bytes = bundle.read(namespace, path);
    if (bytes === undefined) throw new Error(`asset ${namespace}/${path} is unreadable`);
    const abs = join(staging, ...path.split("/"));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
  }
  chmodSync(staging, 0o755);
  const old = `${dest}.${unique}.old`;
  let moved = false;
  try {
    renameSync(dest, old);
    moved = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    renameSync(staging, dest);
  } catch (error) {
    // a concurrent extraction put its tree in place first: keep it
    rmSync(staging, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOTEMPTY" && code !== "EEXIST") {
      if (moved) renameSync(old, dest);
      throw error;
    }
  }
  if (moved) rmSync(old, { recursive: true, force: true });
  return dest;
};
