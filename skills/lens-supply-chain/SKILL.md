---
name: lens-supply-chain
description: Supply-chain review lens (VTC spec 5.3). Use when a task adds or upgrades a dependency, changes a lockfile, or adds a build plugin or install hook; the license, vulnerability and allowlist gates run first; cite the rule id.
---

# Supply-chain lens

Applies to: new or upgraded dependencies, lockfile changes, build plugins, install hooks. The
dependency allowlist, license and vulnerability gates run first; their facts come from the
engine's package metadata, never from memory.

- **DEP-1** A new dependency is named by the task or an architecture decision; otherwise it is a
  finding.
- **DEP-2** Versions are pinned exactly and the lockfile is updated in the same change; no
  floating ranges for production dependencies where the project pins.
- **DEP-3** The package is the intended one: check the exact name against typosquats and
  dependency confusion (a public package shadowing an internal name).
- **DEP-4** No install scripts or native build steps unless the task names them.
- **DEP-5** The package is maintained: a recent release and an active repository, per the
  engine's facts; a very new or barely used package needs a reason.
- **DEP-6** The license is on the project's allowlist; copyleft or unknown licenses park the task.
- **DEP-7** Prefer the standard library or an existing dependency over a new package for small
  functions.

Sources: written for VTC from the role catalogue's supply-chain gap analysis and
security-architect.md (supply chain section) in msitarzewski/agency-agents (MIT, see NOTICE).
