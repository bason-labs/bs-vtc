---
name: stack-compose
description: "Jetpack Compose stack pack (VTC spec 5.2a). Load for a task whose code uses Jetpack Compose (detected from Gradle files with Compose dependencies): conventions, pitfalls and test commands."
---

# Jetpack Compose (Android) stack pack

Detect: Gradle build files with Compose enabled; Kotlin files with composable functions.

## Conventions

- Composables are stateless where possible; state hoisted to the caller or a ViewModel.
- UI state exposed as immutable state from the ViewModel; events go up as callbacks.
- Coroutines in viewModelScope or lifecycle-aware scopes; no GlobalScope.
- Strings, dimensions and colours from resources and the theme.

## Pitfalls

- Unstable parameters and work in composition cause excess recomposition; remember computations.
- Collecting flows without lifecycle awareness keeps working in the background.
- Configuration changes and process death lose state unless it is saved.
- Runtime permissions need rationale and denial handling.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit tests through the Gradle test task; UI tests through the instrumented or Compose test tasks
  the gates name.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
