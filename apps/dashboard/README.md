# Flow Studio (apps/dashboard)

Read-only local dashboard (spec §17), sub-project 6. Increment 1 is built: runs list, the flow
graph at all three zoom levels (phases, task DAG, one task's pipeline with its fix loop) live over
SSE, the node drawer, escalations (read-only), the per-host usage panel, the feature view with
Final Review and PR state, and a plain-text artifact view.

Pages (fixed, AD-20): `/`, `/run/?run=&zoom=phases|tasks&node=`, `/task/?run=&task=&node=`,
`/feature/?run=&feature=`, `/escalations/?run=`, `/usage/`, `/artifact/?run=&path=`. Every page
renders the same client app (`src/components/app/FlowStudio.tsx`), which picks the view from the
address and switches views with `history.pushState` (`src/lib/router.ts`).

`next` is a **devDependency**: it is the build tool, only `out/` ships, and its native SWC
binaries must stay out of the production dependency closure (AD-2, `supply-chain.test.ts`). So
`src/` never imports `next/*` (AD-11 rule 9): routing is our own, fonts are self-hosted
(Fontsource) so the dashboard works offline.

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

- `pnpm dev:fixtures` serves the golden run (`scripts/fixture-server.ts`: recorded routes, the
  event log replayed as SSE, any well-formed nonce accepted); `pnpm dev` proxies `/api/*` to it
  (`VTC_DEV_API` overrides the target). `pnpm build && pnpm dev:fixtures --static out [--live]`
  serves the real export by the engine's AD-20 rules on `http://127.0.0.1:4310/`.
- Tests: `pnpm test` (vitest + Testing Library in jsdom) against the same fixture.

- Build against `fixtures/golden-run/`: `events.jsonl` (replay it as the SSE stream) and `api/*.json`
  (the exact response of every read route).
- Not built yet: against a live engine, `next dev` proxies `/api/*` to the engine found in
  `~/.vtc/engines/<repo-key>.json`, injecting the token, setting `Host` and dropping `Origin`. The
  engine never sends CORS headers.

See `docs/architecture/vtc-spine.md`.
