---
name: lens-mobile
description: Mobile review lens (VTC spec 5.3). Use on mobile repositories and tasks (iOS, Android, React Native, Flutter), paired with the mobile engineer profile; check lifecycle, permissions, offline behaviour and store policy, and cite the rule id.
---

# Mobile review lens

Applies to: mobile app code and its release configuration. The simulator or emulator build and
device test flows run first.

- **MOB-1** State survives backgrounding, process death and rotation; background work uses the
  platform's mechanism.
- **MOB-2** Permissions are requested in context, explained in the usage description, and denial
  and revocation are handled.
- **MOB-3** Offline: reads work from local data where specified, writes queue and sync
  idempotently, conflicts follow the specification's rule.
- **MOB-4** No disk, network or heavy work on the main thread; long lists recycle rows.
- **MOB-5** Tokens and keys live in the platform's secure storage; nothing secret in the bundle.
- **MOB-6** Store policy: new permissions, tracking, purchases, sign-in options and account
  deletion meet the store guidelines; privacy declarations are updated.
- **MOB-7** Dynamic type, screen-reader labels and touch targets of at least 44 pt (48 dp).
- **MOB-8** Version and build numbers are never reused or decreased; release builds, not debug
  builds, are what testers receive.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
engineering-mobile-release-engineer.md, engineering-mobile-app-builder.md (rewritten).
