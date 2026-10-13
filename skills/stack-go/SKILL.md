---
name: stack-go
description: "Go stack pack (VTC spec 5.2a). Load for a task whose code uses Go (detected from go.mod): conventions, pitfalls and test commands."
---

# Go stack pack

Detect: a `go.mod` file and `*.go` files.

## Conventions

- Follow the repository's package layout; small packages named for what they provide.
- Errors are values: return them with context (`fmt.Errorf` with `%w`), check every one, never
  ignore with `_` without a reason.
- Pass `context.Context` as the first parameter of anything that does I/O, and honour
  cancellation.
- Interfaces are declared where they are used and kept small.
- Format with gofmt; follow go vet and the project's linters.

## Pitfalls

- Goroutines without a way to stop leak; every goroutine has an owner and an exit.
- Shared maps and slices across goroutines need synchronisation; run tests with the race detector.
- Loop variables captured by closures behave differently across Go versions; check the module's Go
  version.
- Deferred calls in loops accumulate until the function returns.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Tests: `go test ./...`, with `-race` where the gates use it; `go vet ./...`.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
