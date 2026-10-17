---
name: stack-svelte
description: "Svelte or SvelteKit stack pack (VTC spec 5.2a). Load for a task whose code uses Svelte or SvelteKit (detected from svelte or @sveltejs/kit in package.json): conventions, pitfalls and test commands."
---

# Svelte and SvelteKit stack pack

Detect: `svelte` or `@sveltejs/kit` in package.json, `*.svelte` files, `svelte.config.*`.

## Conventions

- Follow the reactivity style the project uses (runes or the older reactive statements); do not
  mix them in one component.
- SvelteKit: load data in the route's load functions and mutate through form actions or endpoints
  as the project does; server-only modules stay server-only.
- Shared state uses the project's stores or shared state modules.

## Pitfalls

- Mutating nested objects may not trigger updates in older reactivity styles; reassign or use the
  project's state primitives.
- Browser-only code must not run during server rendering.
- Only public environment variables may be imported into client code.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Component tests usually use Vitest with Testing Library; end-to-end tests usually Playwright.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
