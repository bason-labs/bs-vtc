---
name: stack-dotnet
description: ".NET stack pack (VTC spec 5.2a). Load for a task whose code uses .NET (detected from *.csproj or *.sln files): conventions, pitfalls and test commands."
---

# .NET (C#) stack pack

Detect: `*.csproj` or `*.sln` files; C# sources.

## Conventions

- Follow the solution's project layout; dependency injection through the built-in container.
- Async all the way: async methods return Task, take a CancellationToken where they do I/O, and
  are awaited.
- Configuration bound to options classes; validation on request models.
- Nullable reference types as the project configures them; no new warnings.

## Pitfalls

- Blocking on async code (`.Result`, `.Wait()`) deadlocks or starves threads.
- DbContext instances are not thread-safe; one per request scope.
- Interpolated strings in raw SQL are injection unless passed through the parameterising API.
- Disposable resources must be disposed (using declarations).

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Tests with `dotnet test` on the solution or the test projects the gates name; build with
  warnings as the project treats them.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
