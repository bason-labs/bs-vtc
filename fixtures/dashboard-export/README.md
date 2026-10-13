# Dashboard export fixture

A tiny stand-in for `apps/dashboard/out` (`ASSET_SOURCES.dashboard`): the shape of a Next.js static
export with `output: "export"` and `trailingSlash: true` (AD-20). The engine-core team tests its
static serving against it (`resolveDashboardAsset`, `dashboardAssetHeaders`) before the real
dashboard exists; `packages/shared/test/asset-paths.test.ts` checks the rules against it.

- `index.html`: the Flow Studio shell (`/`, and the fallback for client-side routes).
- `task/index.html`: a fixed page; run and task ids come from the query string
  (`/task/?run=golden-1&task=T-2`).
- `_next/static/chunks/app-3f9a.js`: a content-hashed asset (`immutable` cache).
- `icon.svg`: a static file served by its exact path.
