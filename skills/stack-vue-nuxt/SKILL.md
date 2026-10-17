---
name: stack-vue-nuxt
description: "Vue or Nuxt stack pack (VTC spec 5.2a). Load for a task whose code uses Vue or Nuxt (detected from vue or nuxt in package.json): conventions, pitfalls and test commands."
---

# Vue and Nuxt stack pack

Detect: `vue` or `nuxt` in package.json, `*.vue` files, a `nuxt.config.*` file.

## Conventions

- Follow the component style the project uses (Composition API with script setup, or Options API);
  do not mix styles in one component.
- Shared state goes through the project's store (Pinia or its existing one), not module-level
  variables.
- Nuxt: use its data-fetching composables for server-rendered data and its auto-imports as the
  project does; server routes live where the project keeps them.
- Props are typed and never mutated; children emit events instead.

## Pitfalls

- Destructuring reactive objects loses reactivity unless done through the reactivity helpers.
- `v-if` with `v-for` on the same element and missing `:key` on lists cause subtle rendering bugs.
- Code that touches window or document must run only on the client in server-rendered apps.
- Only runtime config marked public reaches the browser; keep secrets in private config.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Component tests usually use Vitest with Vue Test Utils or Testing Library; end-to-end tests
  usually Playwright.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
