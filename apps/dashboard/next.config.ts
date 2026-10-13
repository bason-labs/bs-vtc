import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";
import { PHASE_DEVELOPMENT_SERVER } from "next/constants";

/** The repo root: Turbopack must see `packages/shared` (a workspace dependency). */
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

/** Where `next dev` sends `/api/*`: the golden-run fixture server by default (AD-5 rule 8). */
const devApi = process.env.VTC_DEV_API ?? "http://127.0.0.1:4310";

/**
 * Flow Studio is a static export (AD-20): `output: "export"` with `trailingSlash: true` into
 * `apps/dashboard/out`, which the engine serves by `resolveDashboardAsset`. Pages are fixed; run
 * and task ids travel in the query string (`/task/?run=r1&task=T-2`).
 */
export default function config(phase: string): NextConfig {
  const base: NextConfig = {
    output: "export",
    trailingSlash: true,
    reactStrictMode: true,
    devIndicators: false,
    // `pnpm typecheck` (tsc) checks types; the export build does not repeat it.
    typescript: { ignoreBuildErrors: true },
    turbopack: { root: repoRoot },
  };
  if (phase !== PHASE_DEVELOPMENT_SERVER) return base;
  // Dev only: one origin for the browser, so the API needs no CORS (the engine never sends any).
  return {
    ...base,
    rewrites: () =>
      Promise.resolve([{ source: "/api/:path*", destination: `${devApi}/api/:path*` }]),
  };
}
