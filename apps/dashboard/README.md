# Flow Studio (apps/dashboard)

Read-only local dashboard (spec §17). **Not built yet**: it lands in sub-project 6.

- Next.js 16 **static export**, React 19, Tailwind v4, Radix, lucide, React Flow (`@xyflow/react` 12).
  Source lives in `src/` (incl. `src/app/`); the `@/` alias maps to `src/` (dependency-cruiser
  resolves it, AD-1 rule 9).
- Static export (AD-20): `output: "export"`, `trailingSlash: true`, into `apps/dashboard/out`. Pages
  are fixed; run and task ids go in the query string (`/task/?run=r1&task=T-2`), never in path
  segments. The engine serves it by `resolveDashboardAsset` (deep links fall back to `index.html`);
  `fixtures/dashboard-export/` is the seeded stand-in the engine tests against.
- Theme, ui kit and flow canvas are copied from `bs-job-agents/apps/web` (spec D14, §17).
- Talks to the engine **only over HTTP/SSE**: routes and response contracts are frozen in
  `ENGINE_HTTP` (`@vtc/shared`). It may import `@vtc/shared` contracts through the package entry,
  and nothing else from `packages/` (AD-1).
- Writes nothing except design-review pins (`POST /api/design/reviews`, AD-5 rule 5).
- Served by the `vtc` binary on `127.0.0.1` (AD-5). No cookies: `vtc dashboard` opens
  `/#nonce=<nonce>`; the page exchanges the nonce once (`POST /api/session`) for a session token,
  keeps it in memory or `sessionStorage`, and sends `Authorization: Bearer <session>` on every
  request, reading the SSE stream with `fetch` streaming (EventSource cannot send headers).
- Artifacts (spec, design, evidence bundles) come from `GET /api/runs/:run/artifacts?path=` as
  JSON; diffs from `/tasks/:task/diff`; features from `/features`.
- Design review: the prototype comes from the separate prototype origin
  (`HealthResult.prototype_url`) and is embedded only in `<iframe sandbox="allow-scripts">`
  (`ENGINE_HTTP.prototype.iframeSandbox`), never with `allow-same-origin`.
- Without a running engine, `vtc dashboard` serves the same routes read-only from the committed
  `.vtc/` snapshot.

Development (AD-5 rule 8):

- Build against `fixtures/golden-run/`: `events.jsonl` (replay it as the SSE stream) and `api/*.json`
  (the exact response of every read route).
- Against a live engine, `next dev` proxies `/api/*` to the engine found in
  `~/.vtc/engines/<repo-key>.json`, injecting the token, setting `Host` and dropping `Origin`. The
  engine never sends CORS headers.

See `docs/architecture/vtc-spine.md`.
