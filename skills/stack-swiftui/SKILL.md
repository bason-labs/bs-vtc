---
name: stack-swiftui
description: "SwiftUI stack pack (VTC spec 5.2a). Load for a task whose code uses SwiftUI (detected from an Xcode project or Package.swift with SwiftUI views): conventions, pitfalls and test commands."
---

# SwiftUI (iOS) stack pack

Detect: an `.xcodeproj` or `Package.swift`, Swift files importing SwiftUI.

## Conventions

- Views are small and describe state; state ownership follows the project's pattern (observable
  models, environment, view state).
- Side effects run in tasks tied to the view's lifetime and are cancelled when it disappears.
- Networking and persistence through the project's existing services; UI updates on the main
  actor.
- Strings localised through the project's string catalogue.

## Pitfalls

- Creating an owned model inside a view body re-creates it on every render; own it with the right
  property wrapper.
- Main-thread work in body or initialisers causes hitches.
- Keychain, not user defaults, for tokens.
- Privacy usage descriptions are required for each permission the app requests.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit and UI tests through xcodebuild test with the scheme and simulator the gates name.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.
