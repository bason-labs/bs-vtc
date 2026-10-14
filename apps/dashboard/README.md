# Flow Studio (apps/dashboard)

Read-only local dashboard (spec §17), sub-project 6: runs list, the flow graph at all three zoom
levels (phases, task DAG, one task's pipeline with its fix loop) live over SSE, the node drawer
(with gate reports per layer L0–L6), escalations (read-only), the per-host usage panel, the
feature view with Final Review and PR state, the artifact view (evidence bundles and traceability
reports as a REQ → test → result matrix, everything else as plain text), and the design review.

Pages (fixed, AD-20): `/`, `/run/?run=&zoom=phases|tasks&node=`, `/task/?run=&task=&node=`,
`/feature/?run=&feature=`, `/escalations/?run=`, `/usage/`, `/artifact/?run=&path=`,
`/design/?run=&screen=&state=&viewport=390|768|1440&theme=light|dark`, `/gates/?run=`,
`/research/?run=`, `/lookback/?run=`. Every page
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
- Wave 3 (contracts 4.5.0, spine §5 reading 109: no new route or MCP tool, everything from data
  the dashboard already receives):
  - **Gates** (`/gates/`): every `gate.requested` with the G2 design directions (novelty, the
    first-viewport screenshot through the artifacts route, the prototype shown on demand in the
    same `<iframe sandbox="allow-scripts">` as the design review, never as a page of its own), the
    facts still unverified with why and the waiver reason given (`gate.approved`
    `fact_waivers`, `fact.waived`), the DESIGN coverage check, and the decision. The run view
    shows a banner while a gate waits in the Lead chat; a request still open when the run
    finished reads "Not decided before the run ended".
  - **Engine-launched runs** (run view): `headless.started` / `headless.ended` plus
    `StatusResult.headless_runs` (active run only) with how each ended. A start with no end is
    "Running" only while the live engine reports it (or when that is unknown); otherwise "No end
    recorded", and "Did not finish" once the run finished. A failed `headless.preflight` (resolved
    by a later passing one of the same host and purpose) and a run that ended other than `done`
    (resolved by a later `done` run of the same role and task) are run notices.
  - **Level 3** (feature view): the `merge.preflight` (and what to configure when the run fell to
    Level 2), the latest `feature.checklist` with each item's evidence, the auto-merge timeline
    (`feature.auto_merge_*`, `feature.post_merge_ci`, `feature.reverted`), the PR's number,
    auto-merge state, required checks and `merge_state_status`, and the §6.7a steps from
    `final_review.step_finished`. Red base CI, a revert, auto-merge turned off and a failed
    preflight are also run notices.
  - **Research** (`/research/`): the current row of every fact in `.vtc/research/facts.jsonl`
    (the newest row of each id; an id is hidden only when a later row supersedes it; lines that
    break `FactRow` reported by number), what needs attention first, with source, locator and any
    G2 waiver.
  - **Lookback** (`/lookback/`): `.vtc/lookback/scorecards/index.json` (an entry whose path is not
    under `.vtc/lookback/scorecards/` is reported, never fetched), then each role and host's
    latest `Scorecard`: every proportion with n and its 95% Wilson interval, "insufficient data"
    when `value` is null or n is below `LOOKBACK_LIMITS.minScorecardN`, the Engineer breakdown;
    and the run's `lookback.*` events (canaries, replays, proposals, rollbacks, escaped defects).
    A scorecard opened in the artifact view renders the same way.
  - These views read the run's event log in pages of `EVENT_PAGE_LIMIT.max`, at most 50 pages; a
    longer log is read oldest first and each view says that its newest events are not shown.
  - **Visual QA**: `GateReport.visual` in the gate reports, and a `VisualReport` under
    `.vtc/evidence/` in the artifact view as the render matrix (screen × state × width × theme),
    axe violations and items needing review, per-region diffs and style mismatches. Only `pass`
    counts as passed: `skipped` and `unchecked` show as "Not passed" (reading 105). Raster
    screenshots and diff images (base64 from the artifacts route) show as images; SVG never does.
  - Unknown event types and payloads that break their contract are skipped (`src/lib/events.ts`
    reads payloads with `parsePersisted`, so keys a newer engine adds are dropped).
- Node states: a `WorkflowNode` `interrupted` by a usage limit is drawn with the `waiting_limit`
  style (`vtc-node-waiting-limit`) and labelled "Waiting for limit" (spine §5 reading 34).
- Transcripts: there is no transcript route (spine §5 reading 33). The node drawer shows the host
  session id and that transcripts stay in `.vtc/state/`, which the API never serves.
- Without a running engine, `vtc dashboard` serves the same routes read-only from the committed
  `.vtc/` snapshot.

Development (AD-5 rule 8):

- `pnpm dev:fixtures` serves the golden run (`scripts/fixture-server.ts`: recorded routes, the
  event log replayed as SSE, any well-formed nonce accepted), plus the dashboard's own
  `dev-fixtures/` (an evidence bundle, traceability report and visual QA report with a screenshot
  for T-1, Lookback scorecards, research facts, `screens.yaml`, pins, and a
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
