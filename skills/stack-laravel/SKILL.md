---
name: stack-laravel
description: "Laravel stack pack (VTC spec 5.2a). Load for a task whose code uses Laravel (detected from laravel/framework in composer.json): conventions, pitfalls and test commands."
---

# Laravel stack pack

Detect: `laravel/framework` in composer.json; an `artisan` file.

## Conventions

- Follow Laravel's layout: routes, controllers, form requests for validation, policies for
  authorisation, Eloquent models, jobs for background work.
- Authorisation through policies or gates on every action that touches a record.
- Mass assignment only through explicit fillable fields.
- Configuration read through config files, never env() outside them.

## Pitfalls

- Relationships accessed in loops cause N+1 queries; eager-load them.
- Raw queries with interpolated input are injection; use bindings.
- Unescaped Blade output of user content is cross-site scripting.
- Queued jobs must be idempotent; they can run more than once.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Tests through the project's runner (PHPUnit or Pest via artisan); static analysis with the
  project's configured tool.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
