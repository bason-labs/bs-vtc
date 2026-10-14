<!-- vtc:locked -->

## Frontend profile

This task is frontend work: components, state, routing, forms, accessibility and performance in
the browser. The design system document, the component manifest, the screens list and the
approved prototype in your inputs are the specification of what the user sees.

### Rules

1. Build only from the component registry and the design tokens. No raw colours, arbitrary sizes
   or one-off components when the registry has one; a component the registry lacks is added
   inside the write scope following the registry's conventions.
2. Every screen state the screens list requires (empty, loading, error, success, no permission)
   is implemented and reachable, not only the happy path.
3. Semantic HTML first: native elements before ARIA; every interactive element has an accessible
   name, is reachable and operable by keyboard, and shows visible focus.
4. Forms: labels tied to inputs, errors announced and attached to their field, no data lost on a
   failed submit.
5. Contrast at least 4.5:1 for text (3:1 for large text and UI parts), touch targets at least 44 by
   44 px, nothing conveyed by colour alone, layouts that work at 320 px width and 200% zoom.
6. Performance: no layout shift from late content (reserve space), no long task in an input
   handler, images sized and lazy-loaded below the fold, code split at route boundaries. Watch
   LCP, INP and CLS, not FID.
7. User-facing strings go through the project's i18n mechanism when it has one; never build a
   sentence by concatenation.
8. State lives at the lowest component that needs it; server data goes through the project's
   existing data layer, never a new one.
9. Build against the interface contract you consume. Until the provider's code exists, use its
   contract-generated mocks; never invent fields the contract does not define.
10. The design direction: when the Dispatch section has a `design direction` line, the human
    chose that direction at G2. Build each key screen you touch to that direction's
    `## Direction <id>` block in the screen's design contract
    (`{{design_contracts_dir}}/<screen id>.md`) and ignore the other directions' blocks. Without
    the line, build to the one direction the contracts hold, or to the design system alone when
    they hold none (the category standard); when they hold several, stop with `blocked` and ask
    which one.

### Before `built`

Run the gate commands, including the end-to-end, accessibility and bundle-size gates when the
pack lists them. Check each required state of each screen you touched at the narrow and wide
viewports the gates use.
<!-- vtc:editable -->

### Frontend heuristics

- Match the prototype's structure first, styling second; most visual findings come from wrong
  structure.
- When a list can be long, decide its empty, loading and many-items behaviour before writing it.
