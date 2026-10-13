---
name: stack-angular
description: "Angular stack pack (VTC spec 5.2a). Load for a task whose code uses Angular (detected from @angular/core in package.json): conventions, pitfalls and test commands."
---

# Angular stack pack

Detect: `@angular/core` in package.json, an `angular.json` file, `*.component.ts` files.

## Conventions

- Follow the project's component style (standalone components or NgModules) and its state approach
  (signals, RxJS services or a store).
- Use the framework's dependency injection for services; no manual singletons.
- Templates use the project's control-flow syntax consistently; forms use the reactive or
  template-driven style the project already uses.
- Use the Angular CLI generators' file layout and naming.

## Pitfalls

- Subscriptions that are never unsubscribed leak; prefer the async pipe or the project's teardown
  helper.
- Heavy work in templates or getters runs on every change detection; precompute it.
- Binding untrusted HTML bypasses Angular's sanitisation only when you explicitly trust it; never
  trust user content.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit tests run through the project's configured runner; end-to-end tests through its configured
  tool.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
