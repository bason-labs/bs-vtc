---
name: domain-desktop
description: "Desktop apps (Electron and Tauri) domain pack (VTC spec 5.2a). Load when the repository or the specification shows an Electron or Tauri app (electron or @tauri-apps in dependencies, a src-tauri directory); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Desktop apps (Electron and Tauri) domain pack

Load when: an Electron or Tauri app (electron or @tauri-apps in dependencies, a src-tauri
directory).

## Rules

- **DESK-1** Renderer content is untrusted: Electron windows use context isolation, sandboxing and
  no Node integration; Tauri capabilities are scoped to the commands each window needs.
- **DESK-2** IPC is a public API: every channel validates its input on the privileged side, checks
  authorisation for sensitive operations, and exposes a narrow verb (save this export), never a
  generic one (write any file).
- **DESK-3** Remote content never gets privileges: no remote URL in a privileged window; external
  links open in the system browser.
- **DESK-4** Builds are signed and notarised; signing material never enters the repository.
- **DESK-5** Updates are signed, staged and verified, with a tested rollback; a failed update must
  leave a working app.
- **DESK-6** Platform conventions per OS: menus, shortcuts (Cmd or Ctrl), window controls, tray
  behaviour.
- **DESK-7** Offline is a normal state: the app opens and shows local data with a clear sync
  status.
- **DESK-8** Cold start, idle memory and installer size are measured against the budgets the
  specification sets.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-desktop-app-
engineer.md (its automatic publish step removed).
