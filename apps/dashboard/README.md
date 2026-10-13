# Flow Studio (apps/dashboard)

Read-only local dashboard (spec §17). **Not built yet**: it lands in sub-project 6.

- Next.js 16 **static export**, React 19, Tailwind v4, Radix, lucide, React Flow (`@xyflow/react` 12).
  Source lives in `src/` (incl. `src/app/`); the `@/` alias maps to `src/` (dependency-cruiser
  resolves it, AD-1 rule 9).
- Theme, ui kit and flow canvas are copied from `bs-job-agents/apps/web` (spec D14, §17).
- Talks to the engine **only over HTTP/SSE**: routes and response contracts are frozen in
  `ENGINE_HTTP` (`@vtc/shared`). It may import `@vtc/shared` contracts through the package entry,
  and nothing else from `packages/` (AD-1).
- Writes nothing except design-review pins (`POST /api/design/reviews`, AD-5 rule 5).
- Served by the `vtc` binary on `127.0.0.1` with a per-install token (AD-5). Without a running
  engine, `vtc dashboard` serves the same routes read-only from the committed `.vtc/` snapshot.

Development (AD-5 rule 8):

- Build against `fixtures/golden-run/`: `events.jsonl` (replay it as the SSE stream) and `api/*.json`
  (the exact response of every read route).
- Against a live engine, `next dev` proxies `/api/*` to the engine found in
  `~/.vtc/engines/<repo-key>.json`, injecting the token, setting `Host` and dropping `Origin`. The
  engine never sends CORS headers.

See `docs/architecture/vtc-spine.md`.
