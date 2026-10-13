# Flow Studio (apps/dashboard)

Read-only local dashboard (spec §17), sub-project 6: runs list, the flow graph at all three zoom
levels (phases, task DAG, one task's pipeline with its fix loop) live over SSE, the node drawer
(with gate reports per layer L0–L6), escalations (read-only), the per-host usage panel, the
feature view with Final Review and PR state, the artifact view (evidence bundles and traceability
reports as a REQ → test → result matrix, everything else as plain text), and the design review.

Pages (fixed, AD-20): `/`, `/run/?run=&zoom=phases|tasks&node=`, `/task/?run=&task=&node=`,
`/feature/?run=&feature=`, `/escalations/?run=`, `/usage/`, `/artifact/?run=&path=`,
`/design/?run=&screen=&state=&viewport=390|768|1440&theme=light|dark`. Every page
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
- Design review: the screens come from `DESIGN_SCREENS_PATH` (`.vtc/design/screens.yaml`, read
  through the artifacts route) and are parsed with `parsePersisted(DesignScreensFileSchema)` from
  `@vtc/shared` (spine §5 reading 32): unknown keys a newer Designer wrote are dropped, and a file
  that breaks the contract is refused as a whole with the first problem shown. A screen without
  states is shown with one state, `default`. The prototype comes from the separate prototype
  origin (`HealthResult.prototype_url`) at `prototypeStatePath(route, state, theme)`
  (`<route>?state=<state>&theme=<light|dark>`), embedded only in `<iframe sandbox="allow-scripts">`
  (`ENGINE_HTTP.prototype.iframeSandbox`), never with `allow-same-origin`, and scaled to fit at
  the §7.5 widths. Pins are read from `.vtc/design/reviews/<screen>.jsonl` and written with
  `POST /api/design/reviews`; a pin is a percentage of the frame, so it only lines up on the
  state, width and theme it was made on (the others are listed, not drawn). Keyboard users place
  a pin with Enter and the position fields.
- Run notices (run and feature views): the run's event log (`GET /api/runs/:run/events`, every
  page) is read for the typed events the human must see without anything waiting on an answer:
  `branch.push_failed` and `feature.pr_failed` (marked resolved once a later `branch.pushed` or
  `feature.pr_updated` of the same feature succeeds), `incident.recorded` (`config_changed`: the
  run keeps its frozen config; `checkout_write` with its evidence; the unclean-end kinds) and
  `run.merge_level_changed` (`no_remote`: Level 2+ without a push remote runs at Level 1). It
  re-reads when one of those events arrives (`notices` topic). Nothing shows when there is none.
- Node states: a `WorkflowNode` `interrupted` by a usage limit is drawn with the `waiting_limit`
  style (`vtc-node-waiting-limit`) and labelled "Waiting for limit" (spine §5 reading 34).
- Transcripts: there is no transcript route (spine §5 reading 33). The node drawer shows the host
  session id and that transcripts stay in `.vtc/state/`, which the API never serves.
- Without a running engine, `vtc dashboard` serves the same routes read-only from the committed
  `.vtc/` snapshot.

Development (AD-5 rule 8):

- `pnpm dev:fixtures` serves the golden run (`scripts/fixture-server.ts`: recorded routes, the
  event log replayed as SSE, any well-formed nonce accepted), plus the dashboard's own
  `dev-fixtures/` (an evidence bundle and traceability report for T-1, `screens.yaml`, pins, and a
  sample prototype on port 4311 with `PROTOTYPE_CSP`); it keeps posted pins in memory. `pnpm dev`
  proxies `/api/*` to it (`VTC_DEV_API` overrides the target). Open the dashboard on
  `http://127.0.0.1:…`, not `localhost`: the prototype's CSP allows framing by `127.0.0.1` only. `pnpm build && pnpm dev:fixtures --static out [--live]`
  serves the real export by the engine's AD-20 rules on `http://127.0.0.1:4310/`.
- Tests: `pnpm test` (vitest + Testing Library in jsdom) against the same fixture.

- Build against `fixtures/golden-run/`: `events.jsonl` (replay it as the SSE stream) and `api/*.json`
  (the exact response of every read route).
- Against a live engine: `pnpm dev:engine --repo <abs path of the target repo>` starts
  `scripts/engine-proxy.ts` on `127.0.0.1:4320`, then `VTC_DEV_API=http://127.0.0.1:4320 pnpm dev`.
  The proxy finds the engine in `$VTC_HOME/engines/<repo-key>.json` (`~/.vtc` by default) on
  every request, injects the install token (refusing a token file others can read, spine §5
  reading 35: only this dev proxy reads it; nothing in `src/`, so nothing in the shipped bundle,
  may, and `test/bundle-guards.test.ts` checks that), sets `Host`
  and drops `Origin`, cookies and the browser's own `Authorization`. It forwards only the routes
  whose `auth` is `token`, never the nonce mint or the statusline ingest. Since it hides the
  browser's `Origin` and `Host` from the engine, it checks them itself first (AD-5 rule 3): `Host`
  must be the proxy's loopback address, and `Origin` and `X-Forwarded-Host`, when present, the
  `next dev` origin (`127.0.0.1:4300` or `localhost:4300`; `--dev-port` changes it). Anything else
  (a DNS-rebinding page, a LAN client) gets `403` before the engine or the token is touched.
  `pnpm dev` binds `next dev` to 127.0.0.1 only. The engine never sends CORS headers.

See `docs/architecture/vtc-spine.md`.
