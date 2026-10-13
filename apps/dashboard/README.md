# Flow Studio (apps/dashboard)

Read-only local dashboard (spec §17). **Not built yet**: it lands in sub-project 6.

- Next.js 16 **static export**, React 19, Tailwind v4, Radix, lucide, React Flow (`@xyflow/react` 12).
- Theme, ui kit and flow canvas are copied from `bs-job-agents/apps/web` (spec D14, §17).
- Talks to the engine **only over HTTP/SSE** (`ENGINE_HTTP` in `@vtc/shared`). It may import
  `@vtc/shared` contracts, and nothing else from `packages/` (AD-1, enforced by dependency-cruiser).
- Served by the `vtc` binary on `127.0.0.1` with a per-install token (AD-5).

See `docs/architecture/vtc-spine.md`.
