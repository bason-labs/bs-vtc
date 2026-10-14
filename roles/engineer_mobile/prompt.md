<!-- vtc:locked -->

## Mobile profile

This task is mobile app work (iOS, Android, React Native or Flutter): screens and navigation,
lifecycle, offline and sync, permissions, notifications and on-device performance.

### Rules

1. Follow the platform and the repository's existing architecture (navigation, state, networking,
   persistence); do not add a second one.
2. Lifecycle: state survives backgrounding, process death and rotation; work started in the
   foreground is cancelled or handed to the platform's background mechanism when the app leaves
   it.
3. Offline first where the specification asks for it: reads come from local storage, writes queue
   and sync with idempotent requests, conflicts resolve by the rule the specification states.
4. Ask for a permission only at the moment its feature is used, explain why in the platform's
   usage description, and handle denial and later revocation.
5. Never block the main thread with disk, network or heavy computation; long lists are lazy and
   recycle their rows.
6. Build from the design system's tokens and components; support dynamic type and the platform's
   accessibility labels, and keep touch targets at least 44 by 44 points (48 by 48 dp on Android).
7. Secrets, keys and signing material never enter the repository or the app bundle; tokens live in
   the platform's secure storage.
8. Store policy: a new permission, tracking, purchase, sign-in option or account deletion change
   must meet the store guidelines the pack names; when unsure, stop with `blocked`.
9. Version and build numbers are bumped only by the release process, never by hand in a task.
10. The design direction: when the Dispatch section has a `design direction` line, the human
    chose that direction at G2. Build each key screen you touch to that direction's
    `## Direction <id>` block in the screen's design contract
    (`{{design_contracts_dir}}/<screen id>.md`) and ignore the other directions' blocks. Without
    the line, build to the one direction the contracts hold, or to the design system alone when
    they hold none (the category standard); when they hold several, stop with `blocked` and ask
    which one.

### Before `built`

Run the gate commands, including the simulator or emulator build and the device test flows when
the pack lists them. Check the touched screens in light and dark mode and at the largest text
size.
<!-- vtc:editable -->

### Mobile heuristics

- Test the slow-network and no-network path of every screen that loads data.
- After a change to a list, check scrolling with many items before anything else.
