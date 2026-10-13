/**
 * Where embedded assets come from and how the engine serves the dashboard (AD-2 rule 7, AD-20).
 * Shared so the dashboard team (what it exports), the cli+binary team (what the `AssetBundle`
 * holds, in development and in the binary) and the engine-core team (how `/` is served) agree.
 */
import { HostIdSchema, type HostId } from "./primitives.js";

/**
 * Build outputs the cli's `AssetBundle` reads in development (paths relative to the VTC product
 * repo root) and the binary build embeds. The dashboard is a Next.js static export with
 * `output: "export"` and `trailingSlash: true`, so every page is `<route>/index.html`. Flow Studio
 * has a fixed set of pages: run and task ids go in the query string (`/task/?run=r1&task=T-2`),
 * never in path segments, because a static export cannot pre-render `/runs/:run`.
 */
export const ASSET_SOURCES = {
  dashboard: "apps/dashboard/out",
  "plugin:claude-code": "dist/claude-plugin",
  "plugin:codex": "dist/codex-plugin",
} as const;

/**
 * Where the compiler writes the compiled role contracts inside each plugin namespace
 * (`plugin:claude-code`, `plugin:codex`): a JSON array of `RoleContract`, one per role, built from
 * `roles/<role>/role.yaml` (AD-14). The daemon loads them from its `AssetBundle` and refuses to
 * start on a broken or incomplete set: write scopes, exits, verdicts and models come from these
 * contracts (AD-8 rule 9), never from a second copy in the engine. The plugin manifest sits next
 * to it (`PLUGIN_MANIFEST_ASSET`).
 */
export const ROLE_CONTRACTS_ASSET = "vtc/role-contracts.json";

/**
 * Pure: the dashboard asset that answers `urlPath` (the request's pathname), or `null` (404).
 * `has` says whether the bundle holds a path (`AssetBundle.read(...) !== undefined`). Order:
 * 1. `/api` and `/api/...` are never assets;
 * 2. a path with a `.` or empty segment, a `..`, a backslash or a NUL is refused;
 * 3. the exact file, then `<path>/index.html`, then `<path>.html` (`/` → `index.html`);
 * 4. otherwise, for a path whose last segment has no extension, the SPA fallback `index.html`
 *    (client-side routes); a missing file with an extension stays a 404, so a missing script is
 *    never answered with HTML.
 */
export const resolveDashboardAsset = (
  urlPath: string,
  has: (path: string) => boolean,
): string | null => {
  if (!urlPath.startsWith("/")) return null;
  if (urlPath === "/api" || urlPath.startsWith("/api/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\\") || decoded.includes("\0")) return null;
  const trimmed = decoded.slice(1);
  const segments = trimmed.split("/");
  const inner = trimmed.endsWith("/") ? segments.slice(0, -1) : segments;
  if (trimmed !== "" && inner.some((s) => s === "" || s === "." || s === "..")) return null;
  const candidates =
    trimmed === ""
      ? ["index.html"]
      : trimmed.endsWith("/")
        ? [`${trimmed}index.html`]
        : [trimmed, `${trimmed}/index.html`, `${trimmed}.html`];
  const found = candidates.find((path) => has(path));
  if (found !== undefined) return found;
  const last = inner.at(-1) ?? "";
  return !last.includes(".") && has("index.html") ? "index.html" : null;
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json",
  map: "application/json",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};

/**
 * Response headers for a dashboard asset: `Content-Type` by extension (unknown →
 * `application/octet-stream`), always `X-Content-Type-Options: nosniff`, and `Cache-Control`
 * `immutable` for Next's content-hashed `_next/static/` files, `no-cache` for everything else.
 */
export const dashboardAssetHeaders = (path: string): Readonly<Record<string, string>> => {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  return {
    "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    "cache-control": path.startsWith("_next/static/")
      ? "public, max-age=31536000, immutable"
      : "no-cache",
  };
};

/**
 * Where the cli extracts the binary's `plugin:<host>` assets before calling
 * `HostAdapter.install` (relative to `~/.vtc/`): `plugins/<vtc-version>/<host>`. In development
 * `pluginDir` is `ASSET_SOURCES["plugin:<host>"]` instead.
 */
export const extractedPluginDir = (vtcVersion: string, host: HostId): string => {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(vtcVersion)) {
    throw new TypeError(`expected a semver vtc version, got ${vtcVersion}`);
  }
  return `plugins/${vtcVersion}/${HostIdSchema.parse(host)}`;
};
