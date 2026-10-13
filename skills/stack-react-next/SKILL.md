---
name: stack-react-next
description: "React or Next.js stack pack (VTC spec 5.2a). Load for a task whose code uses React or Next.js (detected from react or next in package.json): conventions, pitfalls and test commands."
---

# React and Next.js stack pack

Detect: `react` or `next` in package.json, a `next.config.*` file, `app/` or `pages/` route
directories.

## Conventions

- Components are functions; state lives in the lowest component that needs it; lift it only when
  two siblings need it.
- Next.js: follow the router the project uses (app or pages); in the app router, components are
  server components unless the file opts into the client, and client-only code (state, effects,
  browser APIs) lives in client components.
- Data fetching goes through the project's existing layer (server components, route handlers, a
  query library); never add a second one.
- Forms use the project's form library and schema validation when it has them; server-side
  validation always repeats client validation.
- Styling follows the project's system (CSS modules, Tailwind, a component library) and its
  tokens.

## Pitfalls

- Effects that set state from props, missing effect dependencies, and effects used for derived
  values cause loops and stale UI; compute derived values during render.
- List keys must be stable ids, never array indexes for lists that reorder.
- Hydration mismatches come from rendering time, randomness or browser-only values on the server.
- Secrets must never reach client bundles; only explicitly public environment variables are
  exposed to the browser.
- Large client components and barrel imports inflate bundles; import what you use.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit and component tests usually run with the project's runner and Testing Library; query by
  role and label.
- End-to-end flows usually run with Playwright; type checks with the project's typecheck script.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
